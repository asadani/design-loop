import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { apply, baseline, computeSignals, initMap, loadCoverage, loadMap, propose, saveCoverage } from "../core/src/index.ts";
import type { Op, Signal } from "../core/src/index.ts";
import { loadGolden } from "./score.ts";
import type { Golden, GoldenNode } from "./score.ts";

/**
 * Replay benchmark. Walk a repo's real history from a base commit through checkpoints and ask: when the code's
 * architecture changes, does design-loop notice? "Architecture changed" is computed from the code itself (Go packages
 * appearing or vanishing, imports between mapped components appearing or vanishing), never from the tool under test.
 *
 * Layer 1 (this file, free): the map is the golden map adjusted to the base commit, nobody edits it, and after each
 * checkpoint an ideal maintainer re-anchors every flagged cite. We score the deterministic signals only.
 */

// ---------------------------------------------------------------- repo state from git (no checkout needed)

export interface RepoState { commit: string; packages: Set<string>; pkgEdges: Set<string> }   // edge = "from\tto"

const git = (repo: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30 });

/** Read many blobs in one process. `specs` are "<commit>:<path>". */
function catBlobs(repo: string, specs: string[]): string[] {
  if (!specs.length) return [];
  const out = git(repo, ["cat-file", "--batch"], specs.join("\n") + "\n");
  const res: string[] = [];
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(10, i);
    const head = out.subarray(i, nl).toString().split(" ");
    if (head[1] === "missing") { res.push(""); i = nl + 1; continue; }
    const size = Number(head[2]);
    res.push(out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    i = nl + 1 + size + 1;
  }
  return res;
}

/** Import paths of a Go file. Only the header (before the first declaration) is read, comments removed. */
export function goImports(src: string): string[] {
  const cut = src.search(/^(func|type|var|const)\b/m);
  const head = (cut < 0 ? src : src.slice(0, cut)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out: string[] = [];
  for (const m of head.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) for (const q of m[1].matchAll(/"([^"]+)"/g)) out.push(q[1]);
  for (const m of head.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1]);
  return out;
}

const isSource = (f: string) => f.endsWith(".go") && !f.endsWith("_test.go") && !/(^|\/)(testdata|vendor)\//.test(f);

/** Packages (directories with non-test Go files) and package-to-package imports inside the module, at a commit. */
export function gitState(repo: string, commit: string): RepoState {
  const mod = /^module\s+(\S+)/m.exec(catBlobs(repo, [`${commit}:go.mod`])[0])?.[1];
  if (!mod) throw new Error(`no go.mod module line at ${commit}`);
  const files = git(repo, ["ls-tree", "-r", "--name-only", commit]).toString().split("\n").filter(isSource);
  const srcs = catBlobs(repo, files.map((f) => `${commit}:${f}`));
  const pkgOf = (f: string) => (dirname(f) === "." ? "." : dirname(f));
  const packages = new Set(files.map(pkgOf));
  const pkgEdges = new Set<string>();
  files.forEach((f, i) => {
    const from = pkgOf(f);
    for (const imp of goImports(srcs[i])) {
      if (imp !== mod && !imp.startsWith(mod + "/")) continue;
      const to = imp === mod ? "." : imp.slice(mod.length + 1);
      if (to !== from && packages.has(to)) pkgEdges.add(`${from}\t${to}`);
    }
  });
  return { commit, packages, pkgEdges };
}

// ---------------------------------------------------------------- architectural events between two states

type Pathed = Pick<GoldenNode, "id" | "paths">;
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

/** The most specific node whose path contains the package, or null when no node covers it. */
export function nodeFor(pkg: string, nodes: Pathed[]): string | null {
  let best: string | null = null, len = -1;
  for (const n of nodes) for (const p of n.paths ?? []) if (under(pkg, p) && p.length > len) { best = n.id; len = p.length; }
  return best;
}

export interface Events {
  newPkgs: { pkg: string; node: string | null }[];
  removedPkgs: { pkg: string; node: string | null }[];
  /** Component-level dependency changes. An endpoint not covered by any node is written "?<package>". */
  edgesAdded: { from: string; to: string }[];
  edgesRemoved: { from: string; to: string }[];
}

function nodeEdges(s: RepoState, nodes: Pathed[]): Set<string> {
  const out = new Set<string>();
  for (const e of s.pkgEdges) {
    const [a, b] = e.split("\t");
    const na = nodeFor(a, nodes) ?? `?${a}`, nb = nodeFor(b, nodes) ?? `?${b}`;
    if (na !== nb) out.add(`${na}\t${nb}`);
  }
  return out;
}

export function events(before: RepoState, after: RepoState, nodes: Pathed[]): Events {
  const eb = nodeEdges(before, nodes), ea = nodeEdges(after, nodes);
  const pair = (e: string) => { const [from, to] = e.split("\t"); return { from, to }; };
  return {
    newPkgs: [...after.packages].filter((p) => !before.packages.has(p)).sort().map((pkg) => ({ pkg, node: nodeFor(pkg, nodes) })),
    removedPkgs: [...before.packages].filter((p) => !after.packages.has(p)).sort().map((pkg) => ({ pkg, node: nodeFor(pkg, nodes) })),
    edgesAdded: [...ea].filter((e) => !eb.has(e)).sort().map(pair),
    edgesRemoved: [...eb].filter((e) => !ea.has(e)).sort().map(pair),
  };
}

export const eventCount = (e: Events) => e.newPkgs.length + e.removedPkgs.length + e.edgesAdded.length + e.edgesRemoved.length;

// ---------------------------------------------------------------- snapshots

/** Replace everything in `out` except `.design/` with the tracked tree at `commit`, then remove `strip` paths. No .git. */
export function materialize(repo: string, commit: string, out: string, strip: string[]): { removed: string[]; missing: string[] } {
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out)) if (name !== ".design") rmSync(join(out, name), { recursive: true, force: true });
  const idx = join(mkdtempSync(join(tmpdir(), "dl-idx-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync("git", ["-C", repo, "read-tree", commit], { env });
  execFileSync("git", ["-C", repo, "checkout-index", "-a", `--prefix=${resolve(out)}/`], { env });
  rmSync(dirname(idx), { recursive: true, force: true });
  const removed: string[] = [], missing: string[] = [];
  for (const p of strip) {
    if (existsSync(join(out, p))) { rmSync(join(out, p), { recursive: true, force: true }); removed.push(p); } else missing.push(p);
  }
  return { removed, missing };
}

// ---------------------------------------------------------------- config

export type Expect = "must" | "may" | "noise" | "control";
export interface Checkpoint { commit: string; label: string; expect: Expect; note?: string }
export interface ReplayConfig {
  repo: string;
  source: string;            // git repo with full history
  golden: string;            // golden map (pinned at a LATER commit)
  base: string;
  strip: string[];
  /** Golden nodes that do not exist at the base commit (created during the window). */
  dropAtBase?: string[];
  /** Folders and extensions for design-loop's "uncovered" signal. Enabled at the base commit with today's gaps acknowledged. */
  coverage?: { roots: string[]; extensions: string[] };
  checkpoints: Checkpoint[];
}

export function loadConfig(file: string): ReplayConfig {
  const c = parse(readFileSync(file, "utf8")) as ReplayConfig;
  const at = (p: string) => resolve(dirname(file), "..", p);   // paths are relative to the bench root (config lives in <bench>/replay/)
  return { ...c, source: at(c.source), golden: at(c.golden), dropAtBase: c.dropAtBase ?? [], strip: c.strip ?? [] };
}

/** The golden map as it should have looked at the base commit. */
export function goldenAtBase(g: Golden, drop: string[]): Golden {
  const keep = g.nodes.filter((n) => !drop.includes(n.id));
  const ids = new Set(keep.map((n) => n.id));
  return { ...g, nodes: keep, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// ---------------------------------------------------------------- layer 1: signals

export interface CheckpointSignals {
  label: string; commit: string; expect: Expect;
  events: Events;
  signals: Signal[];
  /** Events a human would see because a signal fired on a node involved in them. */
  noticed: string[];
  /** Changes that touch the map (a node is involved) and no signal pointed at. */
  silent: string[];
  /** Changes the map does not cover at all (no node involved): no cite-based signal can see these. */
  outside: string[];
  /** Flagged nodes that took part in no event: the listing changed, the architecture did not. */
  noise: string[];
}

const describe = {
  newPkg: (e: { pkg: string; node: string | null }) => `new package ${e.pkg}${e.node ? ` (in ${e.node})` : " (no node covers it)"}`,
  removedPkg: (e: { pkg: string; node: string | null }) => `removed package ${e.pkg}${e.node ? ` (in ${e.node})` : ""}`,
  edge: (e: { from: string; to: string }, sign: string) => `${sign} dependency ${e.from} -> ${e.to}`,
};

export function judge(evs: Events, signals: Signal[], nodes: Pathed[]): Pick<CheckpointSignals, "noticed" | "silent" | "outside" | "noise"> {
  const flagged = new Set(signals.filter((s) => s.node).map((s) => s.node));
  const uncov = signals.filter((s) => s.type === "uncovered" && s.path).map((s) => s.path!);
  const containing = (pkg: string) => nodes.filter((n) => (n.paths ?? []).some((p) => under(pkg, p))).map((n) => n.id);
  const involvedNodes = new Set<string>(), involvedPaths = new Set<string>();
  const noticed: string[] = [], silent: string[] = [], outside: string[] = [];
  /** nodeIds: map nodes involved. pkgs: packages involved that no node covers. */
  const put = (text: string, nodeIds: string[], pkgs: string[]) => {
    nodeIds.forEach((n) => involvedNodes.add(n));
    const byUncov = uncov.filter((u) => pkgs.some((p) => under(p, u)));
    byUncov.forEach((u) => involvedPaths.add(u));
    if (nodeIds.some((n) => flagged.has(n)) || byUncov.length) noticed.push(text);
    else (nodeIds.length ? silent : outside).push(text);
  };
  for (const e of evs.newPkgs) put(describe.newPkg(e), containing(e.pkg), e.node ? [] : [e.pkg]);
  for (const e of evs.removedPkgs) put(describe.removedPkg(e), containing(e.pkg), e.node ? [] : [e.pkg]);
  const real = (id: string) => (id.startsWith("?") ? [] : [id]);
  const loose = (id: string) => (id.startsWith("?") ? [id.slice(1)] : []);
  for (const e of evs.edgesAdded) put(describe.edge(e, "+"), [...real(e.from), ...real(e.to)], [...loose(e.from), ...loose(e.to)]);
  for (const e of evs.edgesRemoved) put(describe.edge(e, "-"), [...real(e.from), ...real(e.to)], [...loose(e.from), ...loose(e.to)]);
  return {
    noticed, silent, outside,
    noise: [...[...flagged].filter((n) => !involvedNodes.has(n)), ...uncov.filter((u) => !involvedPaths.has(u)).map((u) => `uncovered ${u}`)].sort(),
  };
}

function mapOps(g: Golden): Op[] {
  const ops: Op[] = g.nodes.map((n) => ({
    op: "add_node",
    node: n.citable === false || !n.paths?.length
      ? { id: n.id, label: n.label, role: "external" }
      : { id: n.id, label: n.label, role: "backend", status: "stable", cites: n.paths.map((path) => ({ path })) },
  }) as Op);
  g.edges.forEach((e, i) => ops.push({ op: "add_edge", edge: { id: `e${i + 1}`, from: e.from, to: e.to } }));
  return ops;
}

/** Re-anchor the cites of flagged nodes, as a maintainer who acknowledged the change would. Missing paths are dropped. */
function reanchor(work: string, flagged: Set<string>, newlyUncovered: string[]) {
  const cov = loadCoverage(work);
  if (cov && newlyUncovered.length) saveCoverage(work, { ...cov, acknowledged: [...cov.acknowledged, ...newlyUncovered] });
  const map = loadMap(work);
  const ops: Op[] = map.nodes.filter((n) => flagged.has(n.id) && n.cites?.length).map((n) => ({
    op: "update_node", id: n.id, set: { cites: n.cites!.filter((c) => existsSync(join(work, c.path))).map((c) => ({ path: c.path })) },
  }));
  if (ops.length) apply(work, propose(work, { base_rev: map.rev, source: { kind: "import", summary: "replay: re-anchor acknowledged cites" }, ops }).id);
}

export interface SignalsReport { repo: string; base: string; golden: string; coverage: boolean; checkpoints: CheckpointSignals[]; work: string }

export function replaySignals(cfg: ReplayConfig, opts: { coverage?: boolean; work?: string } = {}): SignalsReport {
  const work = opts.work ?? mkdtempSync(join(tmpdir(), "dl-replay-"));
  const useCoverage = (opts.coverage ?? true) && !!cfg.coverage;
  const golden = goldenAtBase(loadGolden(cfg.golden), cfg.dropAtBase ?? []);
  const nodes = golden.nodes.filter((n) => n.citable !== false && n.paths?.length);
  materialize(cfg.source, cfg.base, work, cfg.strip);
  initMap(work, "architecture", `${cfg.repo} replay from ${cfg.base}`);
  apply(work, propose(work, { base_rev: 0, source: { kind: "import", summary: "golden map adjusted to the base commit" }, ops: mapOps(golden) }).id);
  if (useCoverage) {
    const c = { ...cfg.coverage!, acknowledged: [] };
    saveCoverage(work, { ...c, acknowledged: baseline(work, loadMap(work), c) });
  }
  let prev = gitState(cfg.source, cfg.base);
  const out: CheckpointSignals[] = [];
  for (const cp of cfg.checkpoints) {
    materialize(cfg.source, cp.commit, work, cfg.strip);
    const cur = gitState(cfg.source, cp.commit);
    const evs = events(prev, cur, nodes);
    const signals = computeSignals(work);
    out.push({ label: cp.label, commit: cp.commit, expect: cp.expect, events: evs, signals, ...judge(evs, signals, nodes) });
    reanchor(work, new Set(signals.filter((s) => s.node).map((s) => s.node)), signals.filter((s) => s.type === "uncovered").map((s) => s.path!));
    prev = cur;
  }
  return { repo: cfg.repo, base: cfg.base, golden: cfg.golden, coverage: useCoverage, checkpoints: out, work };
}

export function signalsMarkdown(r: SignalsReport): string {
  const tot = (k: "noticed" | "silent" | "outside" | "noise") => r.checkpoints.reduce((a, c) => a + c[k].length, 0);
  const newUncovered = r.checkpoints.reduce((a, c) => a + c.events.newPkgs.filter((e) => !e.node).length, 0);
  const rows = [
    `# Replay, layer 1 (signals only): ${r.repo} from ${r.base.slice(0, 8)}, coverage signal ${r.coverage ? "ON" : "OFF"}`,
    "",
    "| # | checkpoint | expect | changes | noticed | silent, a node involved | silent, no node involved | signals | noise |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.checkpoints.map((c, i) => `| ${i + 1} | ${c.label} (${c.commit.slice(0, 8)}) | ${c.expect} | ${eventCount(c.events)} | ${c.noticed.length} | ${c.silent.length} | ${c.outside.length} | ${c.signals.length} | ${c.noise.length} |`),
    `| | **total** | | ${r.checkpoints.reduce((a, c) => a + eventCount(c.events), 0)} | **${tot("noticed")}** | **${tot("silent")}** | **${tot("outside")}** | | **${tot("noise")}** |`,
    "",
    "Noticed: a signal fired on a node involved in the change, or an \"uncovered\" signal named a package involved in it. Silent: no signal pointed at it,",
    `split by whether a map node is involved. ${newUncovered} of the changes are new packages no node covers. Noise: a signal tied to no architectural change.`,
    "",
  ];
  r.checkpoints.forEach((c, i) => {
    if (!eventCount(c.events) && !c.noise.length) return;
    rows.push(`## ${i + 1}. ${c.label}`, "");
    for (const s of c.silent) rows.push(`- SILENT, node involved: ${s}`);
    for (const s of c.outside) rows.push(`- silent, no node involved: ${s}`);
    for (const s of c.noticed) rows.push(`- noticed: ${s}`);
    for (const s of c.noise) rows.push(`- noise: ${s} flagged, no architectural change`);
    for (const g of c.signals.filter((x) => x.type === "uncovered")) rows.push(`- signal: ${g.detail}`);
    rows.push("");
  });
  return rows.join("\n");
}

// ---------------------------------------------------------------- timeline (helps choose checkpoints and controls)

export function timeline(repo: string, base: string, end: string, nodes: Pathed[]): { commit: string; date: string; subject: string; goChanged: boolean; events: Events }[] {
  const log = git(repo, ["log", "--first-parent", "--reverse", "--format=%H%x09%cs%x09%s", `${base}..${end}`]).toString().trim().split("\n").filter(Boolean);
  let prev = gitState(repo, base);
  return log.map((line) => {
    const [commit, date, subject] = line.split("\t");
    const changed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).toString().split("\n");
    const goChanged = changed.some(isSource);
    const cur = goChanged || changed.includes("go.mod") ? gitState(repo, commit) : { ...prev, commit };
    const ev = events(prev, cur, nodes);
    prev = cur;
    return { commit, date, subject, goChanged, events: ev };
  });
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const [cmd, cfgFile] = process.argv.slice(2);
  if (!cmd || !cfgFile || !["signals", "timeline"].includes(cmd)) {
    console.error("usage: node bench/replay.ts signals|timeline <bench>/replay/<repo>.yaml");
    process.exit(2);
  }
  const cfg = loadConfig(cfgFile);
  const nodes = goldenAtBase(loadGolden(cfg.golden), cfg.dropAtBase ?? []).nodes.filter((n) => n.citable !== false && n.paths?.length);
  if (cmd === "timeline") {
    const end = cfg.checkpoints.at(-1)?.commit ?? "HEAD";
    for (const t of timeline(cfg.source, cfg.base, end, nodes)) {
      const n = eventCount(t.events);
      console.log(`${t.commit.slice(0, 8)} ${t.date} ${t.goChanged ? "go" : "--"} ${String(n).padStart(2)}  ${t.subject.slice(0, 90)}`);
    }
  } else {
    const runs = cfg.coverage ? [replaySignals(cfg, { coverage: false }), replaySignals(cfg, { coverage: true })] : [replaySignals(cfg)];
    const dir = join(resolve(dirname(cfgFile), ".."), "results", "replay", cfg.repo, `signals-${Date.now().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    const sum = (r: SignalsReport, k: "noticed" | "silent" | "outside" | "noise") => r.checkpoints.reduce((a, c) => a + c[k].length, 0);
    const cmp = ["| coverage signal | changes | noticed | silent, node involved | silent, no node involved | noise | signals on controls |", "|---|---|---|---|---|---|---|",
      ...runs.map((r) => `| ${r.coverage ? "on" : "off"} | ${r.checkpoints.reduce((a, c) => a + eventCount(c.events), 0)} | ${sum(r, "noticed")} | ${sum(r, "silent")} | ${sum(r, "outside")} | ${sum(r, "noise")} | ${r.checkpoints.filter((c) => c.expect === "control").reduce((a, c) => a + c.signals.length, 0)} |`)].join("\n");
    for (const r of runs) {
      const tag = r.coverage ? "coverage-on" : "coverage-off";
      writeFileSync(join(dir, `${tag}.json`), JSON.stringify(r, null, 2) + "\n");
      writeFileSync(join(dir, `${tag}.md`), signalsMarkdown(r));
      rmSync(r.work, { recursive: true, force: true });
    }
    writeFileSync(join(dir, "compare.md"), cmp + "\n");
    console.log(`${cmp}\n\n${signalsMarkdown(runs.at(-1)!)}\n-> ${dir}`);
  }
}
