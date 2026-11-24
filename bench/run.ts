import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auditTranscript, benchRoot, billingCheck, billingPreflight, claudeArgs, finishRun, mcpConfig, prepareRun, runClaude, runScripted, startAutoApprover } from "./harness.ts";
import type { Step } from "./harness.ts";
import { COLD_START_PROMPT, PROMPT_HASH } from "./prompt.ts";

const USAGE = `usage: node bench/run.ts --repo gopass|swagger-php --label <name> [options]

  --agent claude            run Claude Code headless (needs --budget; costs real money)
  --agent scripted:<file>   replay a JSON list of {summary, ops} steps through the real MCP server (free; for testing)
  --runs N                  repeat N times (default 1). Scores are noisy: report the spread, not one run.
  --budget USD              cap PER RUN on Claude Code's estimated API cost (required; on a subscription it caps usage, not money)
  --allow-api-billing       run even if the session would bill an API key instead of your subscription
  --model <alias>           model for --agent claude
  --timeout-min N           kill a run after N minutes (default 25)
  --dry-run                 print what would run, change nothing
`;

const { values: v } = parseArgs({
  options: {
    repo: { type: "string" }, label: { type: "string" }, agent: { type: "string", default: "claude" }, runs: { type: "string", default: "1" },
    budget: { type: "string" }, model: { type: "string" }, "timeout-min": { type: "string", default: "25" }, "dry-run": { type: "boolean", default: false },
    "allow-api-billing": { type: "boolean", default: false },
  },
  strict: true,
});

if (!v.repo || !v.label || !["gopass", "swagger-php"].includes(v.repo)) { console.error(USAGE); process.exit(2); }
const runs = Math.max(1, Math.floor(Number(v.runs)));
const bench = benchRoot();
const stripped = join(bench, "stripped", v.repo), goldenFile = join(bench, "golden", `${v.repo}.yaml`);
const isClaude = v.agent === "claude";
const budget = Number(v.budget ?? 0);

if (isClaude && !(budget > 0)) { console.error("refusing: --agent claude needs --budget <USD> (a hard cap per run)\n"); console.error(USAGE); process.exit(2); }
if (isClaude && !v["dry-run"]) { const why = billingPreflight(process.env, v["allow-api-billing"]); if (why) { console.error(why); process.exit(2); } }
if (!isClaude && !v.agent!.startsWith("scripted:")) { console.error(`unknown --agent ${v.agent}\n`); console.error(USAGE); process.exit(2); }

if (v["dry-run"]) {
  console.log(`repo=${v.repo} runs=${runs} agent=${v.agent} prompt=${PROMPT_HASH}\nstripped=${stripped}\ngolden=${goldenFile}`);
  if (isClaude) {
    const args = claudeArgs({ prompt: "<COLD_START_PROMPT>", mcpConfigPath: "<run>/mcp.json", budgetUsd: budget, model: v.model });
    console.log(`\nclaude ${args.join(" ")}\n\nMCP config: ${mcpConfig("<work copy>")}\n\nprompt:\n${COLD_START_PROMPT}`);
  }
  process.exit(0);
}

for (let i = 1; i <= runs; i++) {
  const runId = `${v.label}-${i}-${Date.now().toString(36)}`;
  const paths = prepareRun({ stripped, repo: v.repo, runId });
  const approver = startAutoApprover(paths.work);
  const t0 = Date.now();
  let audit, timedOut = false;
  if (isClaude) {
    const r = await runClaude({ work: paths.work, out: paths.out, budgetUsd: budget, model: v.model, timeoutMs: Number(v["timeout-min"]) * 60_000 });
    timedOut = r.timedOut;
    audit = auditTranscript(readFileSync(r.transcript, "utf8").split("\n"), paths.work);
    const billing = billingCheck(audit, v["allow-api-billing"]);
    if (billing) { console.error(billing); process.exit(1); }
  } else {
    const steps = JSON.parse(readFileSync(v.agent!.slice("scripted:".length), "utf8")) as Step[];
    await runScripted(paths.work, steps);
  }
  await approver.stop();
  const rec = finishRun({ repo: v.repo, runId, label: v.label, agent: v.agent!, goldenFile, paths, approver: approver.stats, audit, wallMs: Date.now() - t0, timedOut });
  const s = rec.score;
  console.log(`${runId}  nodes ${s.nodes.matched}/${s.nodes.citable} (${s.nodes.recall})  edges ${s.edges.hit}/${s.edges.scored} (${s.edges.recall})  cites ${s.cites.validity}  extras ${s.extras.count}  rev ${rec.final.rev}${rec.tainted ? `  TAINTED: ${rec.taintReasons.join("; ")}` : ""}${audit?.costUsd !== undefined ? `  est. $${audit.costUsd.toFixed(2)}` : ""}`);
  console.log(`  -> ${paths.out}/result.json`);
}
