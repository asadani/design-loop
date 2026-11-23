import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, rescoreRun } from "./harness.ts";

// Re-score every stored run against the CURRENT golden files, from the map saved with each run.
const bench = benchRoot(), root = join(bench, "results");
let n = 0;
if (existsSync(root)) {
  for (const repo of readdirSync(root)) for (const run of readdirSync(join(root, repo))) {
    const dir = join(root, repo, run);
    if (!existsSync(join(dir, "result.json")) || !existsSync(join(dir, "design", "map.yaml"))) continue;
    const r = rescoreRun(dir, join(bench, "golden", `${repo}.yaml`), join(bench, "stripped", repo));
    const s = r.score; n++;
    console.log(`${r.runId}  nodes ${s.nodes.matched}/${s.nodes.citable} (${s.nodes.recall})  edges ${s.edges.hit}/${s.edges.scored} (${s.edges.recall})  golden ${r.goldenHash}`);
  }
}
console.log(`${n} run(s) re-scored`);
