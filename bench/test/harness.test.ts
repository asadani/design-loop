import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { apply, listProposals, loadMap, propose } from "../../core/src/index.ts";
import type { Op } from "../../core/src/index.ts";
import { ALLOWED_BUILTIN, auditTranscript, claudeArgs, finishRun, MCP_TOOLS, prepareRun, runScripted, startAutoApprover } from "../harness.ts";
import type { RunRecord, Step } from "../harness.ts";
import { COLD_START_PROMPT } from "../prompt.ts";
import { loadGolden } from "../score.ts";
import { summarize } from "../report.ts";

// A tiny fake "stripped repo" + golden map, so the whole pipeline can run without cloning anything.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "dl-harness-"));
  const stripped = join(base, "stripped");
  for (const f of ["internal/store/root/a.go", "internal/store/leaf/b.go", "internal/backend/gitfs/c.go"]) {
    mkdirSync(join(stripped, f, ".."), { recursive: true });
    writeFileSync(join(stripped, f), "package x\n");
  }
  const goldenFile = join(base, "golden.yaml");
  writeFileSync(goldenFile, stringify({
    repo: "fake", commit: "abc123",
    nodes: [
      { id: "root", label: "root store", paths: ["internal/store/root"] },
      { id: "leaf", label: "leaf store", paths: ["internal/store/leaf"] },
      { id: "gitfs", label: "gitfs", paths: ["internal/backend/gitfs"] },
    ],
    edges: [{ from: "root", to: "leaf" }, { from: "leaf", to: "gitfs" }],
  }));
  return { base, stripped, goldenFile, opts: { workBase: join(base, "work"), outBase: join(base, "out") }, done: () => rmSync(base, { recursive: true, force: true }) };
}
const node = (id: string, path: string): Op => ({ op: "add_node", node: { id, label: id, role: "backend", status: "stable", cites: [{ path }] } });
const edge = (id: string, from: string, to: string): Op => ({ op: "add_edge", edge: { id, from, to, label: "calls" } });
const steps: Step[] = [
  { summary: "stores", ops: [node("root", "internal/store/root"), node("leaf", "internal/store/leaf")] },
  { summary: "wire them and add the backend", ops: [edge("e1", "root", "leaf"), node("gitfs", "internal/backend/gitfs")] },
  { summary: "backend edge (needs step 2 applied first)", ops: [edge("e2", "leaf", "gitfs")] },
];

test("prepareRun: works on a copy, never touches the original, refuses a repo with history", () => {
  const t = fixture();
  const p = prepareRun({ stripped: t.stripped, repo: "fake", runId: "r1", ...t.opts });
  assert.ok(existsSync(join(p.work, "internal/store/root/a.go")));
  assert.ok(existsSync(join(p.work, ".design/map.yaml")), "map initialised in the copy");
  assert.equal(existsSync(join(t.stripped, ".design")), false, "original untouched");
  assert.ok(!p.work.startsWith(join(homedir(), "Projects")), "work copy is outside the project tree");
  mkdirSync(join(t.stripped, ".git"));
  assert.throws(() => prepareRun({ stripped: t.stripped, repo: "fake", runId: "r2", ...t.opts }), /\.git/);
  assert.throws(() => prepareRun({ stripped: join(t.base, "nope"), repo: "fake", runId: "r3", ...t.opts }), /no stripped repo/);
  t.done();
});

test("end to end: scripted agent -> real MCP server -> auto-approver -> score", async () => {
  const t = fixture();
  const p = prepareRun({ stripped: t.stripped, repo: "fake", runId: "e2e", ...t.opts });
  const approver = startAutoApprover(p.work, 20);
  await runScripted(p.work, steps);
  await approver.stop();
  const rec = finishRun({ repo: "fake", runId: "e2e", label: "scripted", agent: "scripted", goldenFile: t.goldenFile, paths: p, approver: approver.stats, wallMs: 1 });
  assert.equal(loadMap(p.work).rev, 3, "all three steps applied in order");
  assert.equal(rec.score.nodes.recall, 1);
  assert.equal(rec.score.edges.recall, 1);
  assert.equal(rec.score.cites.validity, 1);
  assert.equal(rec.tainted, false);
  assert.deepEqual([approver.stats.applied, approver.stats.rebased, approver.stats.rejected], [3, 0, 0]);
  assert.ok(existsSync(join(p.out, "result.json")) && existsSync(join(p.out, "design/map.yaml")) && existsSync(join(p.out, "design/history/0003.yaml")), "map and history kept for audit");
  assert.equal(JSON.parse(readFileSync(join(p.out, "result.json"), "utf8")).commit, "abc123");
  t.done();
});

test("approver rescues stale proposals by rebasing, and rejects ones that no longer fit, recording why", async () => {
  const t = fixture();
  const p = prepareRun({ stripped: t.stripped, repo: "fake", runId: "stale", ...t.opts });
  const src = { kind: "agent-turn" as const, summary: "x" };
  propose(p.work, { base_rev: 0, source: src, ops: [node("root", "internal/store/root")] });       // #1 applies
  propose(p.work, { base_rev: 0, source: src, ops: [node("leaf", "internal/store/leaf")] });       // #2 stale after #1, rebases cleanly
  propose(p.work, { base_rev: 0, source: src, ops: [node("root", "internal/store/leaf")] });       // #3 duplicates #1's id: cannot rebase
  const approver = startAutoApprover(p.work, 20);
  await approver.stop();
  assert.deepEqual([approver.stats.applied, approver.stats.rebased, approver.stats.rejected], [2, 1, 1]);
  assert.match(approver.stats.reasons[0], /^#3 /);
  assert.equal(listProposals(p.work).find((x) => x.id === 3)!.state, "rejected");
  assert.equal(loadMap(p.work).nodes.length, 2);
  t.done();
});

test("audit: flags reads outside the working copy, ungranted tools, and counts tool errors", () => {
  const work = mkdtempSync(join(tmpdir(), "dl-audit-"));
  const use = (id: string, name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "test-model" }),
    use("1", "Read", { file_path: join(work, "internal/store/root/a.go") }),
    use("2", "Read", { file_path: "internal/store/leaf/b.go" }),                 // relative: inside
    use("3", "Read", { file_path: "/Users/someone/Projects/golden/gopass.yaml" }), // outside
    use("4", "Glob", { pattern: "/etc/**/*.conf" }),                              // absolute glob outside
    use("5", "Grep", { pattern: "x", path: join(work, "..") }),                    // parent dir: outside
    use("6", "Grep", { pattern: "x", path: work }),                                // the root itself: inside
    use("7", "Bash", { command: "ls" }),                                           // never granted
    use("8", "mcp__design-loop__map_propose", {}),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "8", is_error: true, content: [{ type: "text", text: "{\"code\": \"STALE\", \"message\": \"x\"}" }] }] } }),
    "not json at all",
    JSON.stringify({ type: "result", total_cost_usd: 0.42, num_turns: 9, duration_ms: 1234, session_id: "s", is_error: false }),
  ];
  const a = auditTranscript(lines, work);
  assert.equal(a.model, "test-model");
  assert.deepEqual(a.outside.map((x) => x.split(":")[0]).sort(), ["Glob", "Grep", "Read"]);
  assert.ok(a.outside.some((x) => x.includes("golden/gopass.yaml")));
  assert.deepEqual(a.disallowed, ["Bash"]);
  assert.deepEqual(a.toolErrors, { STALE: 1 });
  assert.equal(a.toolCalls.Read, 3);
  assert.equal(a.costUsd, 0.42); assert.equal(a.turns, 9);
  rmSync(work, { recursive: true });
});

test("a tainted audit marks the run tainted", async () => {
  const t = fixture();
  const p = prepareRun({ stripped: t.stripped, repo: "fake", runId: "taint", ...t.opts });
  const rec = finishRun({ repo: "fake", runId: "taint", label: "x", agent: "claude", goldenFile: t.goldenFile, paths: p, approver: { applied: 0, rebased: 0, rejected: 0, reasons: [] }, wallMs: 1,
    audit: { toolCalls: {}, toolErrors: {}, outside: ["Read: /x/golden/gopass.yaml"], disallowed: [] } });
  assert.equal(rec.tainted, true);
  assert.match(rec.taintReasons[0], /outside working copy/);
  t.done();
});

test("claude command line: read-only tools, strict MCP, denies by default, needs a budget", () => {
  assert.throws(() => claudeArgs({ prompt: "p", mcpConfigPath: "/c.json", budgetUsd: 0 }), /budget/);
  assert.throws(() => claudeArgs({ prompt: "p", mcpConfigPath: "/c.json", budgetUsd: NaN }), /budget/);
  const a = claudeArgs({ prompt: "p", mcpConfigPath: "/c.json", budgetUsd: 3, model: "sonnet" });
  const at = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(at("--tools"), "Read,Glob,Grep");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.equal(at("--max-budget-usd"), "3");
  assert.equal(at("--model"), "sonnet");
  const granted = `${at("--tools")},${at("--allowedTools")}`;
  for (const bad of ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent"]) assert.equal(granted.includes(bad), false, bad);
  for (const t of MCP_TOOLS) assert.ok(at("--allowedTools").includes(t));
  assert.equal(MCP_TOOLS.some((t) => /apply|reject|pin|lock/i.test(t)), false, "no decision tool is ever granted");
  assert.deepEqual(ALLOWED_BUILTIN, ["Read", "Glob", "Grep"]);
});

test("the task prompt does not name or hint at any component of the repos under test", () => {
  const terms = ["leaf", "root store", "gitfs", "internal/", "pkg/", "assembler", "augmenter", "compiler", "resolver", "specification", "gopass", "swagger", "openapi", "docs/", "architecture.md", "agents.md"];
  const p = COLD_START_PROMPT.toLowerCase();
  for (const term of terms) assert.equal(p.includes(term), false, `prompt mentions "${term}"`);
  const BENCH = process.env.DESIGN_BENCH ?? join(homedir(), "Projects/asadani/tools/design-loop-bench");
  for (const repo of ["gopass", "swagger-php"]) {
    const gf = join(BENCH, "golden", `${repo}.yaml`);
    if (!existsSync(gf)) continue;
    for (const n of loadGolden(gf).nodes) {
      for (const w of [n.id, ...(n.paths ?? []).flatMap((x) => x.split("/").pop()!.replace(/\.php$/, ""))]) {
        if (w.length > 4) assert.equal(p.includes(w.toLowerCase()), false, `prompt mentions golden term "${w}" (${repo})`);
      }
    }
  }
});

test("report: tainted runs are counted but excluded from the means", () => {
  const mk = (recall: number, tainted: boolean): RunRecord => ({
    repo: "gopass", runId: String(Math.random()), label: "cold", agent: "claude", promptHash: "abc", commit: "x", finished: "", wallMs: 1, tainted, taintReasons: [],
    score: { repo: "gopass", nodes: { golden: 3, citable: 3, matched: 0, recall, missed: [], byName: [] }, edges: { golden: 2, scored: 2, hit: 0, reversed: 0, recall: recall / 2, evaluable: 0, missed: [] }, extras: { count: 4, ids: [] }, cites: { total: 1, valid: 1, validity: 1, groundedNodes: 1, nodes: 1 } },
    final: { rev: 3, nodes: 3, edges: 2, signals: {} }, approver: { applied: 3, rebased: 1, rejected: 0, reasons: [] }, audit: { toolCalls: {}, toolErrors: {}, outside: [], disallowed: [], costUsd: 1.5 },
  });
  const out = summarize([mk(0.5, false), mk(0.7, false), mk(0.99, true)]);
  assert.match(out, /\| gopass \/ cold \/ prompt abc \| 2\/1 \|/, "one cell for the setup, then 2 clean / 1 tainted");
  assert.match(out, /0\.60 \[0\.50-0\.70\]/, "tainted 0.99 is left out");
  assert.match(out, /\$4\.50/, "cost counts every run, tainted or not");
  assert.match(out, /read the spread/);
});
