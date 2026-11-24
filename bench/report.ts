import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, readResult } from "./harness.ts";
import type { RunRecord } from "./harness.ts";

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
const f = (n: number) => n.toFixed(2);
const spread = (x: number[]) => (x.length ? `${f(mean(x))} [${f(Math.min(...x))}-${f(Math.max(...x))}]` : "n/a");

/** Tier recall per run, skipping runs whose golden has no nodes in that tier (an empty tier is n/a, not 0%). */
const tier = (runs: RunRecord[], t: "core" | "peripheral") =>
  runs.map((r) => r.score.nodes.byTier?.[t]).filter((x): x is NonNullable<typeof x> => !!x && x.citable > 0).map((x) => x.recall);

/** Group results by repo + label + prompt + golden version, so scores against different goldens are never averaged. Tainted runs are counted but excluded from the means. */
export function summarize(records: RunRecord[]): string {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = `${r.repo} / ${r.label} / prompt ${r.promptHash} / golden ${r.goldenHash ?? "?"} / scorer v${r.score.scorerVersion ?? 1}`;   // not '|': it would split the markdown cell
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const rows = [
    "| setup | runs (clean/tainted) | node recall | core nodes | peripheral nodes | edge recall (strict) | edge recall (lenient) | cite validity | unjudged extras | approver rescues | est. API cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [k, all] of [...groups].sort()) {
    const ok = all.filter((r) => !r.tainted);
    const cost = all.reduce((a, r) => a + (r.audit?.costUsd ?? 0), 0);
    rows.push(
      `| ${k} | ${ok.length}/${all.length - ok.length} | ${spread(ok.map((r) => r.score.nodes.recall))} | ${spread(tier(ok, "core"))} | ${spread(tier(ok, "peripheral"))} | ${spread(ok.map((r) => r.score.edges.recall))} | ${spread(ok.map((r) => r.score.edges.recallLenient ?? NaN).filter((x) => !Number.isNaN(x)))} | ${spread(ok.map((r) => r.score.cites.validity))} | ${f(mean(ok.map((r) => r.score.extras.count)))} | ${f(mean(ok.map((r) => r.approver.rebased + r.approver.rejected)))} | ${cost ? "$" + f(cost) : "-"} |`,
    );
  }
  return rows.join("\n") + "\n\nCells are mean [min-max] over clean runs. Strict edge recall needs the same endpoints and direction; lenient also accepts an edge to a parent or child of an endpoint. Core = the golden draws an edge to or from the node; peripheral = it does not (a structural rule, chosen after seeing the first gopass results). Few runs and small golden maps: read the spread, not the mean. Costs are Claude Code's API-price estimates; on a subscription nothing is billed per token.\n";
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
