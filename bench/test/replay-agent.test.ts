import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { checkpointContext, driftEpisodes, replayAgent, runMarkdown, totals } from "../replay-agent.ts";
import type { CheckpointResult, ReplayRun } from "../replay-agent.ts";
import type { ReplayConfig } from "../replay.ts";

// A tiny Go repo: c0 base; c1 adds package c (no node covers it) and b starts importing it;
// c2 adds a/sub inside node na (drift on na); c3 is an edit only (control).
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dl-r2-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const put = (f: string, body: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); };
  const commit = (m: string) => { g("add", "-A"); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
  g("init", "-q");
  put("go.mod", "module ex.com/m\n"); put("a/a.go", "package a\n"); put("b/b.go", 'package b\nimport "ex.com/m/a"\n'); put("docs/ARCH.md", "secret architecture\n");
  const c0 = commit("base");
  put("c/c.go", "package c\n"); put("b/b.go", 'package b\nimport (\n\t"ex.com/m/a"\n\t"ex.com/m/c"\n)\n'); put("docs/adr/1.md", "why c exists\n");
  const c1 = commit("feat: add c");
  put("a/sub/s.go", 'package sub\nimport "ex.com/m/a"\n');
  const c2 = commit("refactor: split a");
  put("a/a.go", "package a\n// edited\n");
  const c3 = commit("chore: tidy");
  const bench = mkdtempSync(join(tmpdir(), "dl-r2-bench-"));
  writeFileSync(join(bench, "golden.yaml"), stringify({ repo: "m", commit: c3, nodes: [{ id: "na", label: "A", paths: ["a"] }, { id: "nb", label: "B", paths: ["b"] }], edges: [{ from: "nb", to: "na" }] }));
  const cfg: ReplayConfig = {
    repo: "m", source: dir, golden: join(bench, "golden.yaml"), base: c0, strip: ["docs"], coverage: { roots: ["."], extensions: [".go"] },
    checkpoints: [
      { commit: c1, label: "add c", expect: "must" }, { commit: c2, label: "split a", expect: "noise" }, { commit: c3, label: "tidy", expect: "control" },
    ],
  };
  return { cfg, c: [c0, c1, c2, c3], out: (n: string) => join(bench, n), done: () => { rmSync(dir, { recursive: true, force: true }); rmSync(bench, { recursive: true, force: true }); } };
}

test("checkpointContext: real subjects and changed paths, stripped paths hidden", () => {
  const f = fixture();
  const ctx = checkpointContext(f.cfg.source, f.c[0], f.c[1], f.cfg.strip);
  assert.deepEqual(ctx.subjects, ["feat: add c"]);
  assert.deepEqual(ctx.files.map((x) => `${x.status} ${x.path}`).sort(), ["A c/c.go", "M b/b.go"]);
  assert.ok(!ctx.prompt.includes("docs/"), "the ADR path must not reach the agent");
  assert.match(ctx.prompt, /A c\/c\.go\nM b\/b\.go/, "added files are listed before modified ones");
  f.done();
});

test("oracle agent: everything mapped, drift cleared, the new dependency drawn, no churn, controls untouched", async () => {
  const f = fixture();
  const r = await replayAgent({ cfg: f.cfg, agent: "oracle", label: "o", runId: "o1", outDir: f.out("o1") });
  const [c1, c2, c3] = r.checkpoints;
  assert.deepEqual(c1.newCode, { open: ["c"], mapped: ["c"], carried: [] });
  assert.deepEqual([c1.deps.evaluable, c1.deps.hit], [1, 1], "nb -> c, judged against the agent's own map");
  assert.deepEqual(c2.drift, { open: ["na"], cleared: ["na"] });
  assert.equal(c3.signalsAfter, 0);
  const t = totals(r);
  assert.deepEqual([t.newMapped, t.newOpen, t.churn, t.controlChanges], [1, 1, 0, 0]);
  assert.equal(r.final.score.nodes.recall, 1);
  assert.ok(existsSync(f.out("o1/run.json")) && existsSync(f.out("o1/design/map.yaml")) && existsSync(f.out("o1/cp-01.prompt.txt")));
  assert.match(runMarkdown(r), /New code mapped 100%/);
  f.done();
});

test("idle agent: nothing mapped, unmapped code carried over, no churn", async () => {
  const f = fixture();
  const r = await replayAgent({ cfg: f.cfg, agent: "idle", label: "i", runId: "i1", outDir: f.out("i1") });
  assert.deepEqual(r.checkpoints.map((c) => c.newCode), [
    { open: ["c"], mapped: [], carried: [] }, { open: ["c"], mapped: [], carried: ["c"] }, { open: ["c"], mapped: [], carried: ["c"] },
  ]);
  assert.deepEqual(r.checkpoints[0].deps.unevaluable, ["nb -> ?c"], "c is not in the map, so the dependency cannot be judged");
  const t = totals(r);
  assert.deepEqual([t.newMapped, t.newOpen, t.driftCleared, t.driftOpen, t.churn], [0, 1, 0, 2, 0], "carry-overs are not double counted; drift on na stays open twice");
  f.done();
});

test("careless agent: a reversed edge is lenient-only, unrelated edits are churn, a control change is flagged", async () => {
  const f = fixture();
  const r = await replayAgent({
    cfg: f.cfg, agent: "custom", label: "x", runId: "x1", outDir: f.out("x1"),
    custom: (i) => i === 0
      ? [{ op: "add_node", node: { id: "c", label: "C", role: "backend", status: "stable", cites: [{ path: "c" }] } }, { op: "add_edge", edge: { id: "bad", from: "c", to: "nb" } }]
      : i === 2 ? [{ op: "remove_edge", id: "e1" }, { op: "update_node", id: "nb", set: { label: "Bee" } }] : [],
  });
  const [c1, , c3] = r.checkpoints;
  assert.deepEqual([c1.deps.hit, c1.deps.hitLenient], [0, 1]);
  assert.deepEqual(c3.churn.sort(), ["changed node nb (label)", "removed edge nb -> na"]);
  assert.equal(totals(r).controlChanges, 2);
  f.done();
});

test("claude agent: refuses without a budget; with a fake binary, prompts and transcripts are per checkpoint and audited", async () => {
  const f = fixture();
  await assert.rejects(replayAgent({ cfg: f.cfg, agent: "claude", label: "c", runId: "c0", outDir: f.out("c0") }), /budget/);
  const bin = f.out("fake-claude.sh");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$PWD\\",\\"tools\\":[\\"Read\\",\\"Glob\\",\\"Grep\\"]}"
printf '%s\\n' '{"type":"result","total_cost_usd":0.01,"num_turns":1,"duration_ms":1,"session_id":"s","is_error":false}'
`);
  chmodSync(bin, 0o755);
  await assert.rejects(replayAgent({ cfg: f.cfg, agent: "claude", label: "c", runId: "cx", outDir: f.out("cx"), budgetUsd: 0.5, bin, env: { ANTHROPIC_API_KEY: "x" } }), /would bill an API account/);
  const r = await replayAgent({ cfg: f.cfg, agent: "claude", label: "c", runId: "c1", outDir: f.out("c1"), budgetUsd: 0.5, bin, env: {} });
  assert.equal(r.tainted, false);
  assert.equal(Number(r.costUsd.toFixed(2)), 0.03, "three checkpoints at $0.01");
  assert.ok(existsSync(f.out("c1/cp-01.jsonl")) && existsSync(f.out("c1/cp-03.jsonl")));
  assert.match(readFileSync(f.out("c1/cp-01.prompt.txt"), "utf8"), /feat: add c/);
  f.done();
});

test("claude agent: a session that reports API-key auth stops the replay after that checkpoint", async () => {
  const f = fixture();
  const bin = f.out("fake-api-claude.sh");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$PWD\\",\\"apiKeySource\\":\\"ANTHROPIC_API_KEY\\",\\"tools\\":[\\"Read\\"]}"
printf '%s\\n' '{"type":"result","total_cost_usd":0.01}'
`);
  chmodSync(bin, 0o755);
  await assert.rejects(replayAgent({ cfg: f.cfg, agent: "claude", label: "c", runId: "c2", outDir: f.out("c2"), budgetUsd: 0.5, bin, env: {} }), /apiKeySource "ANTHROPIC_API_KEY"/);
  assert.ok(existsSync(f.out("c2/cp-01.jsonl")) && !existsSync(f.out("c2/cp-02.jsonl")), "no second session was started");
  f.done();
});

test("re-anchoring open drift on a control is maintenance, not over-reaction", async () => {
  const f = fixture();
  const r = await replayAgent({
    cfg: f.cfg, agent: "custom", label: "y", runId: "y1", outDir: f.out("y1"),
    custom: (i, map) => (i === 2 ? [{ op: "update_node", id: "na", set: { cites: map.nodes.find((n) => n.id === "na")!.cites!.map((c) => ({ path: c.path })) } }] : []),
  });
  const ctl = r.checkpoints[2];
  assert.deepEqual(ctl.drift, { open: ["na"], cleared: ["na"] }, "na drifted at checkpoint 2 and nobody fixed it until the control");
  assert.deepEqual(ctl.reanchored, ["na"]);
  assert.equal(totals(r).controlChanges, 0);
  f.done();
});

test("drift is scored per episode: one skipped step counts once, not at every later checkpoint", () => {
  const cp = (open: string[], cleared: string[]) => ({ drift: { open, cleared } }) as unknown as CheckpointResult;
  const run = (cps: CheckpointResult[]) => ({ checkpoints: cps }) as unknown as ReplayRun;
  // x drifts at 0 and is fixed at 0; y drifts at 0, skipped until 2; z drifts at 1 and is never fixed; x drifts again at 3
  const d = driftEpisodes(run([cp(["x", "y"], ["x"]), cp(["y", "z"], []), cp(["y", "z"], ["y"]), cp(["z", "x"], ["x"])]));
  assert.deepEqual(d.list.map((e) => `${e.node}:${e.start}-${e.end}`).sort(), ["x:0-0", "x:3-3", "y:0-2", "z:1-null"]);
  assert.deepEqual([d.episodes, d.sameCheckpoint, d.eventually, d.unresolved], [4, 2, 3, 1]);
  assert.equal(d.meanLife, (1 + 1 + 3 + 3) / 4);
});

test("claude agent: a session during which the machine slept taints the run with a sleep reason", async () => {
  const f = fixture();
  const bin = f.out("fake-claude-sleep.sh");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$PWD\\",\\"apiKeySource\\":\\"none\\",\\"tools\\":[\\"Read\\"]}"
printf '%s\\n' '{"type":"result","total_cost_usd":0.01}'
`);
  chmodSync(bin, 0o755);
  // each wall() call jumps 5 minutes ahead of the monotonic clock: the machine "slept" during every session
  let w = 0, m = 0;
  const clock = { wall: () => (w += 5 * 60_000), mono: () => (m += 1) };
  const r = await replayAgent({ cfg: f.cfg, agent: "claude", label: "s", runId: "s1", outDir: f.out("s1"), budgetUsd: 0.5, bin, env: {}, clock });
  assert.equal(r.tainted, true);
  assert.deepEqual(r.checkpoints[0].taintReasons, ["the machine slept ~5 min during this session"]);
  f.done();
});
