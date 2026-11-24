import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { apply, baseline, computeSignals, diffMaps, initMap, listProposals, loadMap, propose, saveCoverage } from "../core/src/index.ts";
import type { MapDoc, Op, Signal } from "../core/src/index.ts";
import { auditTranscript, billingCheck, billingPreflight, goldenHashOf, runClaude, runScripted, startAutoApprover } from "./harness.ts";
import type { Audit } from "./harness.ts";
import { UPDATE_PROMPT_HASH, updatePrompt } from "./prompt.ts";
import { events, gitState, goldenAtBase, loadConfig, mapOps, materialize, under } from "./replay.ts";
import type { Checkpoint, Events, ReplayConfig, RepoState } from "./replay.ts";
import { loadGolden, score } from "./score.ts";
import type { Result as Score } from "./score.ts";

/**
 * Replay layer 2: an agent keeps the map up to date while the code moves through real history.
 * At each checkpoint the agent sees the commit subjects and changed paths, uses the MCP server, and an auto-approver
 * applies its proposals. We score what it did against the code, using the agent's OWN map to decide which components
 * a change touches. Nothing here judges prose; every number comes from the map and the code.
 */

/** "custom" runs `RunOptions.custom` through the real MCP server (tests use it to play a careless agent). */
export type AgentKind = "claude" | "oracle" | "idle" | "custom";

export interface CheckpointResult {
  label: string; commit: string; expect: Checkpoint["expect"];
  prompt: { subjects: number; files: number };
  /** Folders flagged "uncovered" when the checkpoint started, and which of them the agent's map covers afterwards. */
  newCode: { open: string[]; mapped: string[]; carried: string[] };
  /** Nodes with a cite-moved / cite-missing signal at the start, and which of them are clean afterwards. */
  drift: { open: string[]; cleared: string[] };
  /** Component dependencies the commits introduced, judged against the agent's map. Unevaluable: an endpoint no node covers. */
  deps: { total: number; evaluable: number; hit: number; hitLenient: number; missed: string[]; unevaluable: string[] };
  removedDeps: { total: number; hit: number };
  changes: { nodesAdded: string[]; nodesRemoved: string[]; nodesChanged: string[]; edgesAdded: string[]; edgesRemoved: string[]; edgesChanged: string[] };
  /** Removals and edits with no cause in this checkpoint's code changes. */
  churn: string[];
  /** Nodes whose only change was re-sending cites while they had open drift: maintenance, never over-reaction. */
  reanchored?: string[];   // absent in runs recorded before it existed
  signalsAfter: number;
  approver: { applied: number; rejected: number; reasons: string[] };
  audit?: Audit;
  tainted: boolean; taintReasons: string[];
}

export interface ReplayRun {
  repo: string; runId: string; label: string; agent: AgentKind; model?: string;
  promptHash: string; goldenHash: string; base: string; finished: string;
  checkpoints: CheckpointResult[];
  final: { rev: number; nodes: number; edges: number; score: Score };
  /** Sum of Claude Code's API-price estimates. Not money billed when running on a subscription. */
  costUsd: number; tainted: boolean;
}

// ---------------------------------------------------------------- helpers

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 28 }).toString();

/** What the agent is told: commit subjects and changed paths, with stripped paths (docs, ADRs) removed. */
export function checkpointContext(repo: string, from: string, to: string, strip: string[]) {
  const hidden = (p: string) => strip.some((s) => under(p, s.replace(/\/+$/, "")));
  const subjects = git(repo, ["log", "--first-parent", "--reverse", "--format=%s", `${from}..${to}`]).split("\n").filter(Boolean);
  const files = git(repo, ["diff", "--name-status", "-M", from, to]).split("\n").filter(Boolean).map((l) => {
    const parts = l.split("\t");
    return { status: parts[0], path: parts.at(-1)! };
  }).filter((f) => !hidden(f.path));
  return { subjects, files, prompt: updatePrompt(subjects, files) };
}

/** The agent's map as path-owning components: file cites stand for their folder. */
function mapPathed(map: MapDoc, work: string) {
  return map.nodes.filter((n) => n.cites?.length).map((n) => ({
    id: n.id,
    paths: n.cites!.map((c) => { const abs = join(work, c.path); return existsSync(abs) && statSync(abs).isFile() ? dirname(c.path) : c.path.replace(/\/+$/, ""); }),
  }));
}

const driftNodes = (s: Signal[]) => [...new Set(s.filter((g) => g.type === "cite-moved" || g.type === "cite-missing").map((g) => g.node))].sort();
const uncoveredPaths = (s: Signal[]) => s.filter((g) => g.type === "uncovered").map((g) => g.path!).sort();

export function judgeCheckpoint(o: {
  work: string; before: MapDoc; after: MapDoc; prev: RepoState; cur: RepoState;
  startSignals: Signal[]; endSignals: Signal[]; carriedIn: string[];
}): Pick<CheckpointResult, "newCode" | "drift" | "deps" | "removedDeps" | "changes" | "churn" | "reanchored" | "signalsAfter"> {
  const nodes = mapPathed(o.after, o.work);
  const ev: Events = events(o.prev, o.cur, nodes);
  const has = (a: string, b: string) => o.after.edges.some((e) => e.from === a && e.to === b);
  const real = (x: string) => !x.startsWith("?");

  const open = uncoveredPaths(o.startSignals), stillOpen = new Set(uncoveredPaths(o.endSignals));
  const dOpen = driftNodes(o.startSignals), dStill = new Set(driftNodes(o.endSignals));

  const deps = { total: ev.edgesAdded.length, evaluable: 0, hit: 0, hitLenient: 0, missed: [] as string[], unevaluable: [] as string[] };
  for (const e of ev.edgesAdded) {
    const txt = `${e.from} -> ${e.to}`;
    if (!real(e.from) || !real(e.to)) { deps.unevaluable.push(txt); continue; }
    deps.evaluable++;
    if (has(e.from, e.to)) deps.hit++;
    if (has(e.from, e.to) || has(e.to, e.from)) deps.hitLenient++; else deps.missed.push(txt);
  }
  const removedDeps = { total: ev.edgesRemoved.length, hit: ev.edgesRemoved.filter((e) => !has(e.from, e.to)).length };

  // which nodes this checkpoint gave a reason to touch
  const changedPkgs = [...ev.newPkgs, ...ev.removedPkgs].map((p) => p.pkg);
  const involved = new Set<string>(dOpen);
  for (const n of nodes) if (n.paths.some((p) => changedPkgs.some((pkg) => under(pkg, p)) || open.some((u) => under(u, p) || under(p, u)))) involved.add(n.id);
  for (const e of [...ev.edgesAdded, ...ev.edgesRemoved]) { if (real(e.from)) involved.add(e.from); if (real(e.to)) involved.add(e.to); }

  const d = diffMaps(o.before, o.after);
  const beforeNode = new Map(o.before.nodes.map((n) => [n.id, n]));
  const churn: string[] = [];
  for (const id of d.nodes.removed) {
    const gone = (beforeNode.get(id)?.cites ?? []).every((c) => !existsSync(join(o.work, c.path)));
    if (!gone || !(beforeNode.get(id)?.cites?.length)) churn.push(`removed node ${id} (its code still exists)`);
  }
  for (const c of d.nodes.changed) if (!involved.has(c.id)) churn.push(`changed node ${c.id} (${c.fields.join(", ")})`);
  const removedPairs = new Set(ev.edgesRemoved.map((e) => `${e.from}\t${e.to}`));
  const beforeEdge = new Map(o.before.edges.map((e) => [e.id, e]));
  for (const id of d.edges.removed) {
    const e = beforeEdge.get(id)!;
    const endpointGone = d.nodes.removed.includes(e.from) || d.nodes.removed.includes(e.to);
    if (!endpointGone && !removedPairs.has(`${e.from}\t${e.to}`)) churn.push(`removed edge ${e.from} -> ${e.to}`);
  }
  for (const c of d.edges.changed) { const e = beforeEdge.get(c.id)!; if (!involved.has(e.from) && !involved.has(e.to)) churn.push(`changed edge ${e.from} -> ${e.to} (${c.fields.join(", ")})`); }

  return {
    newCode: { open, mapped: open.filter((p) => !stillOpen.has(p)), carried: open.filter((p) => o.carriedIn.includes(p)) },
    drift: { open: dOpen, cleared: dOpen.filter((n) => !dStill.has(n)) },
    deps, removedDeps,
    changes: { nodesAdded: d.nodes.added, nodesRemoved: d.nodes.removed, nodesChanged: d.nodes.changed.map((c) => c.id), edgesAdded: d.edges.added, edgesRemoved: d.edges.removed, edgesChanged: d.edges.changed.map((c) => c.id) },
    churn,
    reanchored: d.nodes.changed.filter((c) => c.fields.length === 1 && c.fields[0] === "cites" && dOpen.includes(c.id)).map((c) => c.id),
    signalsAfter: o.endSignals.length,
  };
}

// ---------------------------------------------------------------- scripted agents (free; they check the scorer)

const slug = (p: string) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "root";

/** The ideal maintainer, computed from the code: map new code, re-anchor drift, draw new dependencies, drop dead nodes. */
export function oracleOps(work: string, map: MapDoc, signals: Signal[], prev: RepoState, cur: RepoState, tag: string): Op[] {
  const ops: Op[] = [];
  const ids = new Set(map.nodes.map((n) => n.id));
  const planned = map.nodes.map((n) => ({ ...n }));
  for (const p of uncoveredPaths(signals)) {
    let id = slug(p), k = 2; while (ids.has(id)) id = `${slug(p)}-${k++}`;
    ids.add(id);
    const node = { id, label: p, role: "backend", status: "stable" as const, cites: [{ path: p }] };
    ops.push({ op: "add_node", node }); planned.push(node);
  }
  const dead = map.nodes.filter((n) => n.cites?.length && n.cites.every((c) => !existsSync(join(work, c.path)))).map((n) => n.id);
  for (const id of driftNodes(signals)) {
    if (dead.includes(id)) continue;
    const n = map.nodes.find((x) => x.id === id)!;
    ops.push({ op: "update_node", id, set: { cites: n.cites!.filter((c) => existsSync(join(work, c.path))).map((c) => ({ path: c.path })) } });
  }
  const view = { ...map, nodes: planned };
  const ev = events(prev, cur, mapPathed(view, work));
  let k = 0;
  const edgeIds = new Set(map.edges.map((e) => e.id));
  const has = (a: string, b: string) => map.edges.some((e) => e.from === a && e.to === b);
  for (const e of ev.edgesAdded) {
    if (e.from.startsWith("?") || e.to.startsWith("?") || has(e.from, e.to) || dead.includes(e.from) || dead.includes(e.to)) continue;
    let id = `${tag}-${++k}`; while (edgeIds.has(id)) id = `${tag}-${++k}`;
    ops.push({ op: "add_edge", edge: { id, from: e.from, to: e.to } });
  }
  for (const e of ev.edgesRemoved) for (const x of map.edges.filter((m) => m.from === e.from && m.to === e.to)) ops.push({ op: "remove_edge", id: x.id });
  for (const id of dead) {
    for (const x of map.edges.filter((m) => m.from === id || m.to === id)) if (!ops.some((o) => o.op === "remove_edge" && o.id === x.id)) ops.push({ op: "remove_edge", id: x.id });
    ops.push({ op: "remove_node", id });
  }
  return ops;
}

// ---------------------------------------------------------------- one run

export interface RunOptions {
  cfg: ReplayConfig; agent: AgentKind; label: string; runId: string; outDir: string;
  budgetUsd?: number; model?: string; timeoutMs?: number; bin?: string; work?: string;
  custom?: (i: number, map: MapDoc, signals: Signal[]) => Op[];
  /** Accept API billing. Off by default: a run stops if a session is not on the subscription. */
  allowApiBilling?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function drained(work: string, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until && listProposals(work).some((p) => p.state === "pending")) await new Promise((r) => setTimeout(r, 50));
}

export async function replayAgent(o: RunOptions): Promise<ReplayRun> {
  const { cfg } = o;
  if (o.agent === "claude" && !((o.budgetUsd ?? 0) > 0)) throw new Error("refusing: --agent claude needs a positive per-checkpoint budget");
  if (o.agent === "claude") { const why = billingPreflight(o.env ?? process.env, o.allowApiBilling); if (why) throw new Error(why); }
  const work = o.work ?? mkdtempSync(join(tmpdir(), "dl-replay2-"));
  mkdirSync(o.outDir, { recursive: true });
  materialize(cfg.source, cfg.base, work, cfg.strip);
  initMap(work, "architecture", `${cfg.repo} replay (${o.runId})`);
  apply(work, propose(work, { base_rev: 0, source: { kind: "import", summary: "golden map adjusted to the base commit" }, ops: mapOps(goldenAtBase(loadGolden(cfg.golden), cfg.dropAtBase ?? [])) }).id);
  if (cfg.coverage) { const c = { ...cfg.coverage, acknowledged: [] }; saveCoverage(work, { ...c, acknowledged: baseline(work, loadMap(work), c) }); }

  const approver = startAutoApprover(work);
  const results: CheckpointResult[] = [];
  let prevCommit = cfg.base, prev = gitState(cfg.source, cfg.base), carried: string[] = [], cost = 0;
  try {
    for (const [i, cp] of cfg.checkpoints.entries()) {
      materialize(cfg.source, cp.commit, work, cfg.strip);
      const cur = gitState(cfg.source, cp.commit);
      const ctx = checkpointContext(cfg.source, prevCommit, cp.commit, cfg.strip);
      const before = loadMap(work), startSignals = computeSignals(work);
      const a0 = { ...approver.stats, reasons: [...approver.stats.reasons] };
      writeFileSync(join(o.outDir, `cp-${String(i + 1).padStart(2, "0")}.prompt.txt`), ctx.prompt);
      let audit: Audit | undefined, timedOut = false;
      if (o.agent === "oracle" || o.agent === "custom") {
        const ops = o.agent === "oracle" ? oracleOps(work, before, startSignals, prev, cur, `r${i + 1}`) : (o.custom?.(i, before, startSignals) ?? []);
        if (ops.length) await runScripted(work, [{ summary: `oracle: checkpoint ${i + 1}`, ops }]);
      } else if (o.agent === "claude") {
        const r = await runClaude({ work, out: o.outDir, budgetUsd: o.budgetUsd!, model: o.model, timeoutMs: o.timeoutMs ?? 15 * 60_000, bin: o.bin, prompt: ctx.prompt, name: `cp-${String(i + 1).padStart(2, "0")}` });
        timedOut = r.timedOut;
        audit = auditTranscript(readFileSync(r.transcript, "utf8").split("\n"), work);
        cost += audit.costUsd ?? 0;
        const billing = billingCheck(audit, o.allowApiBilling);
        if (billing) throw new Error(billing);
      }
      await drained(work);
      const after = loadMap(work), endSignals = computeSignals(work);
      const taintReasons = [
        ...(audit?.outside.length ? [`read outside the working copy: ${audit.outside.join(", ")}`] : []),
        ...(audit?.disallowed.length ? [`ran tools never granted: ${audit.disallowed.join(", ")}`] : []),
        ...(audit?.grantedExtra.length ? [`session started with tools beyond the allowlist: ${audit.grantedExtra.join(", ")}`] : []),
        ...(timedOut ? ["timed out"] : []),
      ];
      results.push({
        label: cp.label, commit: cp.commit, expect: cp.expect,
        prompt: { subjects: ctx.subjects.length, files: ctx.files.length },
        ...judgeCheckpoint({ work, before, after, prev, cur, startSignals, endSignals, carriedIn: carried }),
        approver: { applied: approver.stats.applied - a0.applied, rejected: approver.stats.rejected - a0.rejected, reasons: approver.stats.reasons.slice(a0.reasons.length) },
        audit, tainted: taintReasons.length > 0, taintReasons,
      });
      carried = uncoveredPaths(endSignals);
      prev = cur; prevCommit = cp.commit;
    }
  } finally {
    await approver.stop();
  }
  const finalMap = loadMap(work);
  const run: ReplayRun = {
    repo: cfg.repo, runId: o.runId, label: o.label, agent: o.agent, model: o.model,
    promptHash: UPDATE_PROMPT_HASH, goldenHash: goldenHashOf(cfg.golden), base: cfg.base, finished: new Date().toISOString(),
    checkpoints: results,
    final: { rev: finalMap.rev, nodes: finalMap.nodes.length, edges: finalMap.edges.length, score: score(loadGolden(cfg.golden), finalMap, work) },
    costUsd: cost, tainted: results.some((r) => r.tainted),
  };
  cpSync(join(work, ".design"), join(o.outDir, "design"), { recursive: true });
  writeFileSync(join(o.outDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(join(o.outDir, "report.md"), runMarkdown(run));
  if (!o.work) rmSync(work, { recursive: true, force: true });
  return run;
}

// ---------------------------------------------------------------- reporting

const ratio = (a: number, b: number) => (b ? `${a}/${b}` : "-");
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) + "%" : "n/a");

/**
 * Drift scored once per episode: an episode starts when a node is drifted at a checkpoint's start and was not still
 * open from the previous checkpoint; it ends at the checkpoint where it is cleared. Counting a node again at every
 * checkpoint it stays open would punish one skipped step many times over.
 */
export function driftEpisodes(r: ReplayRun) {
  const open = new Map<string, number>();            // node -> checkpoint index the episode started
  const eps: { node: string; start: number; end: number | null }[] = [];
  r.checkpoints.forEach((c, i) => {
    for (const n of [...open.keys()]) if (!c.drift.open.includes(n)) { eps.push({ node: n, start: open.get(n)!, end: i - 1 }); open.delete(n); }   // went away without a re-anchor (e.g. code reverted)
    for (const n of c.drift.open) if (!open.has(n)) open.set(n, i);
    for (const n of c.drift.cleared) if (open.has(n)) { eps.push({ node: n, start: open.get(n)!, end: i }); open.delete(n); }
  });
  for (const [n, s] of open) eps.push({ node: n, start: s, end: null });
  const fixed = eps.filter((e) => e.end !== null);
  const life = (e: { start: number; end: number | null }) => (e.end ?? r.checkpoints.length - 1) - e.start + 1;
  return {
    episodes: eps.length, sameCheckpoint: eps.filter((e) => e.end === e.start).length, eventually: fixed.length, unresolved: eps.length - fixed.length,
    /** Checkpoints an episode stayed open, counting the one it started in. 1 = fixed straight away. */
    meanLife: eps.length ? eps.reduce((a, e) => a + life(e), 0) / eps.length : 0,
    list: eps,
  };
}

export function totals(r: ReplayRun) {
  const sum = (f: (c: CheckpointResult) => number) => r.checkpoints.reduce((a, c) => a + f(c), 0);
  const of = (e: string) => r.checkpoints.filter((c) => c.expect === e);
  const changed = (c: CheckpointResult) => Object.values(c.changes).reduce((a, x) => a + x.length, 0);
  return {
    newOpen: sum((c) => c.newCode.open.length - c.newCode.carried.length), newMapped: sum((c) => c.newCode.mapped.filter((p) => !c.newCode.carried.includes(p)).length),
    driftOpen: sum((c) => c.drift.open.length), driftCleared: sum((c) => c.drift.cleared.length),
    drift: driftEpisodes(r),
    depsEval: sum((c) => c.deps.evaluable), depsHit: sum((c) => c.deps.hit), depsLenient: sum((c) => c.deps.hitLenient), depsUneval: sum((c) => c.deps.unevaluable.length),
    churn: sum((c) => c.churn.length),
    /** Any map change on a control checkpoint is an over-reaction: nothing architectural happened. */
    // runs recorded before `reanchored` existed: approximate it as changed nodes that had open drift
    controlChanges: of("control").reduce((a, c) => a + changed(c) - (c.reanchored ?? c.changes.nodesChanged.filter((id) => c.drift.open.includes(id))).length, 0), controls: of("control").length,
    /** Informational: re-anchoring drift on a noise checkpoint is correct, so this is not a penalty. */
    noiseChanges: of("noise").reduce((a, c) => a + changed(c), 0),
    rejected: sum((c) => c.approver.rejected),
  };
}

export function runMarkdown(r: ReplayRun): string {
  const t = totals(r);
  const rows = [
    `# Replay, layer 2: ${r.repo} / ${r.agent}${r.model ? ` (${r.model})` : ""} / ${r.runId}`,
    "",
    `prompt ${r.promptHash} / golden ${r.goldenHash} / estimated API cost $${r.costUsd.toFixed(2)} (not billed on a subscription)${r.tainted ? " / TAINTED" : ""}`,
    "",
    "| # | checkpoint | expect | new code mapped | drifted nodes cleared | new deps drawn (strict / either way) | unevaluable deps | churn | map changes | rejected |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...r.checkpoints.map((c, i) => {
      const ch = c.changes;
      const n = ch.nodesAdded.length + ch.nodesRemoved.length + ch.nodesChanged.length + ch.edgesAdded.length + ch.edgesRemoved.length + ch.edgesChanged.length;
      return `| ${i + 1} | ${c.label} | ${c.expect} | ${ratio(c.newCode.mapped.length, c.newCode.open.length)} | ${ratio(c.drift.cleared.length, c.drift.open.length)} | ${ratio(c.deps.hit, c.deps.evaluable)} / ${ratio(c.deps.hitLenient, c.deps.evaluable)} | ${c.deps.unevaluable.length} | ${c.churn.length} | ${n} | ${c.approver.rejected}${c.tainted ? " TAINTED" : ""} |`;
    }),
    "",
    `**Totals.** New code mapped ${pct(t.newMapped, t.newOpen)} (${t.newMapped}/${t.newOpen}, not counting carry-overs). ` +
      `Drift: ${t.drift.episodes} episodes, ${t.drift.sameCheckpoint} fixed in the checkpoint they appeared, ${t.drift.eventually} fixed eventually, ${t.drift.unresolved} never; mean ${t.drift.meanLife.toFixed(1)} checkpoints open. ` +
      `New dependencies drawn ${pct(t.depsHit, t.depsEval)} strict, ${pct(t.depsLenient, t.depsEval)} either way (${t.depsUneval} more had an endpoint no node covers). ` +
      `Churn ${t.churn}. Map changes on the ${t.controls} control checkpoints: ${t.controlChanges} (should be 0). On noise checkpoints: ${t.noiseChanges}. Rejected proposals ${t.rejected}.`,
    "",
    `**Golden preserved (${r.final.nodes} nodes, ${r.final.edges} edges, rev ${r.final.rev}).** The run starts from the golden map, so this checks the agent kept it intact; it does not measure discovery. Node recall ${r.final.score.nodes.recall} (core ${r.final.score.nodes.byTier.core.recall}), edge recall ${r.final.score.edges.recall} strict / ${r.final.score.edges.recallLenient} lenient, cite validity ${r.final.score.cites.validity}.`,
    "",
  ];
  r.checkpoints.forEach((c, i) => {
    const lines = [
      ...c.newCode.open.filter((p) => !c.newCode.mapped.includes(p)).map((p) => `- not mapped: ${p}${c.newCode.carried.includes(p) ? " (carried over)" : ""}`),
      ...c.drift.open.filter((n) => !c.drift.cleared.includes(n)).map((n) => `- drift left: ${n}`),
      ...c.deps.missed.map((d) => `- dependency not drawn: ${d}`),
      ...c.churn.map((x) => `- churn: ${x}`),
      ...c.approver.reasons.map((x) => `- rejected: ${x}`),
      ...c.taintReasons.map((x) => `- TAINT: ${x}`),
    ];
    if (lines.length) rows.push(`## ${i + 1}. ${c.label}`, "", ...lines, "");
  });
  return rows.join("\n");
}

export function summaryMarkdown(runs: ReplayRun[]): string {
  const rows = ["| run | agent | prompt | new code mapped | drift fixed in same checkpoint | drift fixed eventually | mean checkpoints drifted | new deps (strict / either) | churn | changes on controls | golden kept: nodes / edges | est. API cost |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of runs) {
    const t = totals(r), s = r.final.score;
    const d = t.drift;
    rows.push(`| ${r.runId}${r.tainted ? " (TAINTED)" : ""} | ${r.agent} | ${r.promptHash.slice(0, 6)} | ${pct(t.newMapped, t.newOpen)} | ${ratio(d.sameCheckpoint, d.episodes)} | ${ratio(d.eventually, d.episodes)} | ${d.meanLife.toFixed(1)} | ${pct(t.depsHit, t.depsEval)} / ${pct(t.depsLenient, t.depsEval)} | ${t.churn} | ${t.controlChanges} | ${s.nodes.recall} / ${s.edges.recall} | $${r.costUsd.toFixed(2)} |`);
  }
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: { config: { type: "string" }, agent: { type: "string", default: "oracle" }, label: { type: "string" }, runs: { type: "string", default: "1" },
      budget: { type: "string" }, model: { type: "string" }, "timeout-min": { type: "string", default: "15" }, "dry-run": { type: "boolean", default: false },
      "allow-api-billing": { type: "boolean", default: false }, rescore: { type: "boolean", default: false } },
    strict: true,
  });
  const USAGE = `usage: node bench/replay-agent.ts --config <bench>/replay/<repo>.yaml --label <name> [--agent oracle|idle|claude] [--runs N]
  --budget USD    cap PER CHECKPOINT on Claude Code's estimated API cost (required for claude; on a subscription it caps usage, not money)
  --allow-api-billing  run even if the session would bill an API key instead of your subscription
  --model alias   --timeout-min N (per checkpoint, default 15)   --dry-run  print each checkpoint's prompt, run nothing
  --rescore       rebuild every stored run's report with the current scoring (needs only --config)`;
  if (v.config && v.rescore) {
    // Rebuild every stored run's report from its run.json with the current scoring (no agent, no cost).
    const base = join(resolve(dirname(v.config), ".."), "results", "replay", loadConfig(v.config).repo);
    const runs = readdirSync(base).filter((d) => existsSync(join(base, d, "run.json"))).sort()
      .map((d) => { const r = JSON.parse(readFileSync(join(base, d, "run.json"), "utf8")) as ReplayRun; writeFileSync(join(base, d, "report.md"), runMarkdown(r)); return r; });
    console.log(summaryMarkdown(runs.filter((r) => r.agent === "claude")));
    process.exit(0);
  }
  if (!v.config || !v.label || !["oracle", "idle", "claude"].includes(v.agent!)) { console.error(USAGE); process.exit(2); }
  const cfg = loadConfig(v.config);
  if (v["dry-run"]) {
    let prevC = cfg.base;
    for (const [i, cp] of cfg.checkpoints.entries()) { console.log(`\n===== checkpoint ${i + 1}: ${cp.label}\n${checkpointContext(cfg.source, prevC, cp.commit, cfg.strip).prompt}`); prevC = cp.commit; }
    process.exit(0);
  }
  if (v.agent === "claude" && !(Number(v.budget) > 0)) { console.error("refusing: --agent claude needs --budget <USD per checkpoint>\n" + USAGE); process.exit(2); }
  if (v.agent === "claude") { const why = billingPreflight(process.env, v["allow-api-billing"]); if (why) { console.error(why); process.exit(2); } }
  const runs: ReplayRun[] = [];
  const base = join(resolve(dirname(v.config), ".."), "results", "replay", cfg.repo);
  for (let i = 1; i <= Math.max(1, Number(v.runs)); i++) {
    const runId = `${v.label}-${i}-${Date.now().toString(36)}`;
    const r = await replayAgent({ cfg, agent: v.agent as AgentKind, label: v.label, runId, outDir: join(base, runId), budgetUsd: Number(v.budget ?? 0), model: v.model, timeoutMs: Number(v["timeout-min"]) * 60_000, allowApiBilling: v["allow-api-billing"] });
    runs.push(r);
    console.log(`${runId}  -> ${join(base, runId)}/report.md`);
  }
  console.log("\n" + summaryMarkdown(runs));
}

