import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { MapDoc } from "../core/src/index.ts";

export interface GoldenNode { id: string; label: string; paths?: string[]; citable?: boolean; evidence?: string }
export interface GoldenEdge { from: string; to: string; evidence?: string; optional?: boolean }
export interface Golden { repo: string; commit: string; nodes: GoldenNode[]; edges: GoldenEdge[] }

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

export interface Result {
  repo: string;
  nodes: { golden: number; citable: number; matched: number; recall: number; missed: string[]; byName: string[] };
  edges: { golden: number; scored: number; hit: number; reversed: number; recall: number; evaluable: number; missed: string[] };
  extras: { count: number; ids: string[] };      // candidate nodes matching nothing: UNJUDGED, not wrong (the doc is partial)
  cites: { total: number; valid: number; validity: number; groundedNodes: number; nodes: number };
}

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

  // --- edges: directed hit, or reversed
  const has = (a: string, b: string) => map.edges.some((e) => e.from === a && e.to === b);
  let hit = 0, reversed = 0, evaluable = 0; const missed: string[] = [];
  const scored = golden.edges.filter((e) => !e.optional);
  for (const e of scored) {
    const a = gMatch.get(e.from), b = gMatch.get(e.to);
    if (!a || !b) { missed.push(`${e.from} -> ${e.to} (endpoint unmatched)`); continue; }
    evaluable++;
    if (has(a, b)) hit++; else if (has(b, a)) { reversed++; missed.push(`${e.from} -> ${e.to} (reversed)`); } else missed.push(`${e.from} -> ${e.to}`);
  }

  // --- cite validity: deterministic, needs no golden data
  let total = 0, valid = 0, grounded = 0;
  for (const n of map.nodes) {
    let ok = 0;
    for (const c of n.cites ?? []) { total++; if (existsSync(join(repoRoot, c.path))) { valid++; ok++; } }
    if (ok) grounded++;
  }
  const r = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);
  return {
    repo: golden.repo,
    nodes: { golden: golden.nodes.length, citable: citable.length, matched: matchedCitable.length, recall: r(matchedCitable.length, citable.length), missed: citable.filter((g) => !gMatch.has(g.id)).map((g) => g.id), byName },
    edges: { golden: golden.edges.length, scored: scored.length, hit, reversed, recall: r(hit, scored.length), evaluable, missed },
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
