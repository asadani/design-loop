import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { apply, initMap, propose } from "../core/src/index.ts";
import type { Op } from "../core/src/index.ts";
import { loadGolden } from "./score.ts";

/**
 * Turn a golden file into a design-loop map so it can be reviewed in the viewer. The review folder is a COPY of the
 * stripped repo (so cites resolve) with a .design/ added. Evidence ("text" / "diagram" / "both") is shown on every
 * node and edge so a reviewer knows what to check it against.
 */
export function goldenToReview(goldenFile: string, strippedRoot: string, outDir: string): { nodes: number; edges: number } {
  const g = loadGolden(goldenFile);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  cpSync(strippedRoot, outDir, { recursive: true });
  initMap(outDir, "architecture", `GOLDEN (draft, review me): ${g.repo} @ ${g.commit}`);
  const ops: Op[] = [];
  for (const n of g.nodes) {
    ops.push({ op: "add_node", node: {
      id: n.id, label: n.label, role: n.citable === false ? "external" : "backend", status: "stable",
      note: `evidence: ${n.evidence ?? "?"}${n.citable === false ? " (not in repo)" : ""}`,
      ...(n.paths?.length ? { cites: n.paths.map((path) => ({ path })) } : {}),
    } });
  }
  g.edges.forEach((e, i) => ops.push({ op: "add_edge", edge: { id: `e${i + 1}`, from: e.from, to: e.to, label: `${e.evidence ?? "?"}${e.optional ? " (optional)" : ""}` } }));
  apply(outDir, propose(outDir, { base_rev: 0, source: { kind: "import", summary: `Golden map from ${g.repo} docs, draft` }, ops }).id);
  return { nodes: g.nodes.length, edges: g.edges.length };
}

if (import.meta.main) {
  const [golden, stripped, out] = process.argv.slice(2);
  if (!golden || !stripped || !out) { console.error("usage: golden-view.ts <golden.yaml> <stripped repo> <out dir>"); process.exit(2); }
  console.log(goldenToReview(golden, stripped, out));
}
