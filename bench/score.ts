import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { MapDoc } from "../core/src/index.ts";

export type Tier = "core" | "peripheral";
export interface GoldenNode { id: string; label: string; paths?: string[]; citable?: boolean; evidence?: string; tier?: Tier }
/** `undirected`: the source states a relationship but not its direction, so either direction counts as a hit. */
export interface GoldenEdge { from: string; to: string; evidence?: string; optional?: boolean; undirected?: boolean }
export interface Golden { repo: string; commit: string; nodes: GoldenNode[]; edges: GoldenEdge[] }

/** Bump whenever scoring rules change, so results scored under different rules are never averaged together. */
export const SCORER_VERSION = 2;

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** 3 = same path, 2 = candidate is inside the golden path (more specific), 1 = candidate is a parent of it. */
function pathRel(c: string, g: string): number {
  c = norm(c); g = norm(g);
  if (c === g) return 3;
  if (c.startsWith(g + "/")) return 2;
  if (g.startsWith(c + "/")) return 1;
  return 0;
}

export interface TierScore { citable: number; matched: number; recall: number; missed: string[] }
export interface Result {
  repo: string;
  scorerVersion: number;
  nodes: { golden: number; citable: number; matched: number; recall: number; missed: string[]; byName: string[]; byTier: Record<Tier, TierScore> };
  /** `hit` is strict (same direction, same endpoints). `hitLenient` also accepts an edge to a parent or child of a
   *  golden endpoint (leaf -> backend satisfies leaf -> gitfs): an abstraction-tolerant reading, reported beside strict. */
  edges: { golden: number; scored: number; hit: number; reversed: number; recall: number; hitLenient: number; recallLenient: number; evaluable: number; missed: string[] };
  extras: { count: number; ids: string[] };      // candidate nodes matching nothing: UNJUDGED, not wrong (the doc is partial)
  cites: { total: number; valid: number; validity: number; groundedNodes: number; nodes: number };
}

/** Structural rule, independent of any run's results: a node is core if the golden draws at least one edge to or from it. */
export function tierOf(golden: Golden, n: GoldenNode): Tier {
  if (n.tier) return n.tier;
  return golden.edges.some((e) => e.from === n.id || e.to === n.id) ? "core" : "peripheral";
}
/** `anc` contains `desc` when one of anc's paths is a strict directory prefix of one of desc's paths. */
const contains = (anc: GoldenNode, desc: GoldenNode) =>
  (anc.paths ?? []).some((a) => (desc.paths ?? []).some((d) => norm(d) !== norm(a) && norm(d).startsWith(norm(a) + "/")));

export function score(golden: Golden, map: MapDoc, repoRoot: string): Result {
  // --- node matching: greedy, best path relation first, each side used once
  const pairs: { g: GoldenNode; id: string; s: number }[] = [];
  for (const g of golden.nodes) {
    if (g.citable === false) continue;
    for (const n of map.nodes) {
      let best = 0;
      for (const c of n.cites ?? []) for (const gp of g.paths ?? []) best = Math.max(best, pathRel(c.path, gp));
      if (best) pairs.push({ g, id: n.id, s: best });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const gMatch = new Map<string, string>(); const used = new Set<string>(); const byName: string[] = [];
  for (const p of pairs) if (!gMatch.has(p.g.id) && !used.has(p.id)) { gMatch.set(p.g.id, p.id); used.add(p.id); }
  // --- name fallback for anything still unmatched (incl. non-citable externals)
  for (const g of golden.nodes) {
    if (gMatch.has(g.id)) continue;
    const names = new Set([tok(g.id), tok(g.label), ...(g.paths ?? []).map((p) => tok(norm(p).split("/").pop() ?? ""))].filter((x) => x.length > 2));
    const hit = map.nodes.find((n) => !used.has(n.id) && (names.has(tok(n.id)) || names.has(tok(n.label))));
    if (hit) { gMatch.set(g.id, hit.id); used.add(hit.id); byName.push(g.id); }
  }
  const citable = golden.nodes.filter((g) => g.citable !== false);
  const matchedCitable = citable.filter((g) => gMatch.has(g.id));

  // --- edges. Strict: both endpoints matched and the edge present in the golden's direction (either, if undirected).
  const has = (a: string, b: string) => map.edges.some((e) => e.from === a && e.to === b);
  const related = (n: GoldenNode) => golden.nodes.filter((g) => g.id === n.id || contains(g, n) || contains(n, g));
  const standIn = (n: GoldenNode) => new Set(related(n).map((g) => gMatch.get(g.id)).filter((x): x is string => !!x));
  const byId = new Map(golden.nodes.map((n) => [n.id, n]));
  let hit = 0, reversed = 0, evaluable = 0, hitLenient = 0; const missed: string[] = [];
  const scored = golden.edges.filter((e) => !e.optional);
  for (const e of scored) {
    const a = gMatch.get(e.from), b = gMatch.get(e.to);
    // lenient: any candidate edge between stand-ins for the endpoints (the node itself, a parent or a child)
    const sa = standIn(byId.get(e.from)!), sb = standIn(byId.get(e.to)!);
    const lenient = [...sa].some((x) => [...sb].some((y) => x !== y && (has(x, y) || (e.undirected && has(y, x)))));
    if (lenient) hitLenient++;
    if (!a || !b) { missed.push(`${e.from} -> ${e.to} (endpoint unmatched)`); continue; }
    evaluable++;
    if (has(a, b) || (e.undirected && has(b, a))) hit++;
    else if (has(b, a)) { reversed++; missed.push(`${e.from} -> ${e.to} (reversed)`); }
    else missed.push(`${e.from} -> ${e.to}`);
  }

  // --- cite validity: deterministic, needs no golden data
  let total = 0, valid = 0, grounded = 0;
  for (const n of map.nodes) {
    let ok = 0;
    for (const c of n.cites ?? []) { total++; if (existsSync(join(repoRoot, c.path))) { valid++; ok++; } }
    if (ok) grounded++;
  }
  const r = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);
  const tierScore = (t: Tier): TierScore => {
    const inTier = citable.filter((g) => tierOf(golden, g) === t);
    const got = inTier.filter((g) => gMatch.has(g.id));
    return { citable: inTier.length, matched: got.length, recall: r(got.length, inTier.length), missed: inTier.filter((g) => !gMatch.has(g.id)).map((g) => g.id) };
  };
  return {
    repo: golden.repo,
    scorerVersion: SCORER_VERSION,
    nodes: { golden: golden.nodes.length, citable: citable.length, matched: matchedCitable.length, recall: r(matchedCitable.length, citable.length), missed: citable.filter((g) => !gMatch.has(g.id)).map((g) => g.id), byName, byTier: { core: tierScore("core"), peripheral: tierScore("peripheral") } },
    edges: { golden: golden.edges.length, scored: scored.length, hit, reversed, recall: r(hit, scored.length), hitLenient, recallLenient: r(hitLenient, scored.length), evaluable, missed },
    extras: { count: map.nodes.length - used.size, ids: map.nodes.filter((n) => !used.has(n.id)).map((n) => n.id) },
    cites: { total, valid, validity: r(valid, total), groundedNodes: grounded, nodes: map.nodes.length },
  };
}

export const loadGolden = (file: string): Golden => parse(readFileSync(file, "utf8")) as Golden;
export const loadCandidate = (dir: string): MapDoc => parse(readFileSync(join(dir, ".design", "map.yaml"), "utf8")) as MapDoc;

if (import.meta.main) {
  const [goldenFile, mapRoot, repoRoot] = process.argv.slice(2);
  if (!goldenFile || !mapRoot || !repoRoot) { console.error("usage: score.ts <golden.yaml> <dir containing .design/> <stripped repo root>"); process.exit(2); }
  console.log(JSON.stringify(score(loadGolden(goldenFile), loadCandidate(mapRoot), repoRoot), null, 2));
}
