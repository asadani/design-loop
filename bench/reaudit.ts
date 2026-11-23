import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, reauditRun } from "./harness.ts";

// Recompute taint for every stored run from its transcript. Use after the audit logic changes. Scores are untouched.
const root = join(benchRoot(), "results");
let n = 0, changed = 0;
if (existsSync(root)) {
  for (const repo of readdirSync(root)) for (const run of readdirSync(join(root, repo))) {
    const dir = join(root, repo, run);
    if (!existsSync(join(dir, "transcript.jsonl"))) continue;
    const r = reauditRun(dir); n++;
    console.log(`${r.runId}  ${r.tainted ? "TAINTED: " + r.taintReasons.join("; ") : "clean"}${r.audit?.deniedAttempts.length ? `  (refused attempts: ${r.audit.deniedAttempts.join(", ")})` : ""}`);
    changed++;
  }
}
console.log(`${n} run(s) re-audited`);
