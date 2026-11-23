import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, readResult } from "./harness.ts";
import type { RunRecord } from "./harness.ts";

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
const f = (n: number) => n.toFixed(2);
const spread = (x: number[]) => (x.length ? `${f(mean(x))} [${f(Math.min(...x))}-${f(Math.max(...x))}]` : "n/a");

/** Group results by repo + label + prompt. Tainted runs are counted but excluded from the means. */
export function summarize(records: RunRecord[]): string {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = `${r.repo} / ${r.label} / prompt ${r.promptHash}`;   // not '|': it would split the markdown cell
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const rows = [
    "| setup | runs (clean/tainted) | node recall | edge recall | cite validity | unjudged extras | approver rescues | cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [k, all] of [...groups].sort()) {
    const ok = all.filter((r) => !r.tainted);
    const cost = all.reduce((a, r) => a + (r.audit?.costUsd ?? 0), 0);
    rows.push(
      `| ${k} | ${ok.length}/${all.length - ok.length} | ${spread(ok.map((r) => r.score.nodes.recall))} | ${spread(ok.map((r) => r.score.edges.recall))} | ${spread(ok.map((r) => r.score.cites.validity))} | ${f(mean(ok.map((r) => r.score.extras.count)))} | ${f(mean(ok.map((r) => r.approver.rebased + r.approver.rejected)))} | ${cost ? "$" + f(cost) : "-"} |`,
    );
  }
  return rows.join("\n") + "\n\nCells are mean [min-max] over clean runs. Few runs and small golden maps: read the spread, not the mean.\n";
}

export function loadAll(root = join(benchRoot(), "results")): RunRecord[] {
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const repo of readdirSync(root)) {
    for (const run of readdirSync(join(root, repo))) {
      const file = join(root, repo, run, "result.json");
      if (existsSync(file)) out.push(readResult(file));
    }
  }
  return out;
}

if (import.meta.main) {
  const all = loadAll();
  console.log(all.length ? summarize(all) : "no results yet");
}
