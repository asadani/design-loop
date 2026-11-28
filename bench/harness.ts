import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "yaml";
import { apply, computeSignals, DesignError, initMap, listProposals, loadMap, paths, rebase, reject } from "../core/src/index.ts";
import type { MapDoc, Op } from "../core/src/index.ts";
import { createServer } from "../mcp/src/server.ts";
import { loadCandidate, loadGolden, score } from "./score.ts";
import type { Result as Score } from "./score.ts";
import { COLD_START_PROMPT, PROMPT_HASH } from "./prompt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const benchRoot = () => process.env.DESIGN_BENCH ?? join(homedir(), "Projects/asadani/tools/design-loop-bench");

// ---------------------------------------------------------------- run directory

export interface RunPaths { work: string; out: string }

/**
 * A run works on a throwaway COPY of the stripped repo in the OS temp dir, deliberately outside the bench tree,
 * so the agent cannot stumble on golden/ or sources/ by walking up. The stripped original is never modified.
 */
export function prepareRun(o: { stripped: string; repo: string; runId: string; outBase?: string; workBase?: string }): RunPaths {
  const work = join(o.workBase ?? join(tmpdir(), "design-loop-bench-runs"), `${o.repo}-${o.runId}`);
  const out = join(o.outBase ?? join(benchRoot(), "results"), o.repo, o.runId);
  if (!existsSync(o.stripped)) throw new Error(`no stripped repo at ${o.stripped}; run make-stripped.sh`);
  if (existsSync(join(o.stripped, ".git"))) throw new Error(`${o.stripped} has a .git: history would leak the removed docs`);
  rmSync(work, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(work), { recursive: true });
  mkdirSync(out, { recursive: true });
  cpSync(o.stripped, work, { recursive: true });
  initMap(work, "architecture", `${o.repo} (bench run ${o.runId})`);
  return { work, out };
}

// ---------------------------------------------------------------- auto-approver (benchmark only)

export interface ApproverStats { applied: number; rebased: number; rejected: number; reasons: string[] }

/**
 * Stands in for the human during a benchmark run: applies pending proposals as they appear. This is NOT part of the
 * product (the MCP server has no apply tool, the CLI needs a terminal). It calls the core library directly, and its
 * stats go into every result so "approver rescued N stale proposals" is visible, not hidden.
 */
export function startAutoApprover(root: string, intervalMs = 100) {
  const stats: ApproverStats = { applied: 0, rebased: 0, rejected: 0, reasons: [] };
  let busy = false;
  const tick = () => {
    if (busy) return; busy = true;
    try {
      for (const p of listProposals(root).filter((x) => x.state === "pending").sort((a, b) => a.id - b.id)) {
        try { apply(root, p.id); stats.applied++; }
        catch (e) {
          if (!(e instanceof DesignError)) throw e;
          try {
            if (e.code === "STALE") { rebase(root, p.id); apply(root, p.id); stats.rebased++; stats.applied++; }
            else throw e;
          } catch (e2) {
            const msg = e2 instanceof DesignError ? `${e2.code}: ${e2.message}` : String(e2);
            reject(root, p.id, msg); stats.rejected++; stats.reasons.push(`#${p.id} ${msg}`);
          }
        }
      }
    } finally { busy = false; }
  };
  const t = setInterval(tick, intervalMs);
  return { stats, stop: async () => { clearInterval(t); await new Promise((r) => setTimeout(r, intervalMs + 20)); tick(); } };
}

// ---------------------------------------------------------------- scripted agent (tests + dry runs)

export interface Step { summary: string; ops: Op[] }

/** Behaves like an agent: reads status, proposes against the rev it saw, then waits to see it applied. */
export async function runScripted(root: string, steps: Step[], waitMs = 5000): Promise<{ calls: number }> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(a);
  const client = new Client({ name: "scripted-agent", version: "0" });
  await client.connect(b);
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    calls++;
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) as Record<string, any> };
  };
  for (const s of steps) {
    const st = await call("map_status");
    const r = await call("map_propose", { base_rev: st.data.rev, source: { kind: "agent-turn", summary: s.summary }, ops: s.ops });
    if (r.isError) continue;
    const until = Date.now() + waitMs;
    while (Date.now() < until && (await call("map_status")).data.pending.length) await new Promise((x) => setTimeout(x, 50));
  }
  await client.close();
  return { calls };
}

// ---------------------------------------------------------------- real agent: Claude Code, headless

export const ALLOWED_BUILTIN = ["Read", "Glob", "Grep"];
export const MCP_TOOLS = ["map_status", "map_read", "map_propose", "map_history", "map_diff", "map_explain_node"].map((t) => `mcp__design-loop__${t}`);

export function mcpConfig(work: string): string {
  return JSON.stringify({ mcpServers: { "design-loop": { command: process.execPath, args: [join(REPO_ROOT, "mcp/src/bin.ts"), work] } } });
}

export function claudeArgs(o: { prompt: string; mcpConfigPath: string; budgetUsd: number; model?: string }): string[] {
  if (!(o.budgetUsd > 0)) throw new Error("refusing to run a real agent without a positive --budget (USD)");
  return [
    "-p", o.prompt,
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", o.mcpConfigPath, "--strict-mcp-config",
    "--tools", ALLOWED_BUILTIN.join(","),                      // no Bash, Edit or Write exist for this agent
    "--allowedTools", [...ALLOWED_BUILTIN, ...MCP_TOOLS].join(","),
    "--permission-mode", "dontAsk",                            // anything not allowed is denied, never prompted
    "--setting-sources", "project",                            // skip user-level settings and hooks
    "--no-session-persistence",
    "--max-budget-usd", String(o.budgetUsd),
    ...(o.model ? ["--model", o.model] : []),
  ];
}

// ---------------------------------------------------------------- billing guard

/** Environment variables that make Claude Code bill an API account instead of the signed-in subscription. */
export const API_BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/** Before any session: refuse if the environment would switch Claude Code to API billing. Names only, never values. */
export function billingPreflight(env: NodeJS.ProcessEnv = process.env, allowApi = false): string | null {
  const set = API_BILLING_ENV.filter((k) => env[k]);
  if (!set.length || allowApi) return null;
  return `refusing: ${set.join(", ")} ${set.length > 1 ? "are" : "is"} set, so claude would bill an API account instead of your subscription. Unset ${set.length > 1 ? "them" : "it"}, or pass --allow-api-billing.`;
}

/** After each session: the transcript says how it actually authenticated. Anything but "none" stops the run. */
export function billingCheck(a: Audit | undefined, allowApi = false): string | null {
  if (allowApi || !a || a.apiKeySource === undefined || a.apiKeySource === "none") return null;
  return `stopping: the session authenticated with apiKeySource "${a.apiKeySource}", not your subscription. Pass --allow-api-billing to accept API billing.`;
}

export interface Clock { wall: () => number; mono: () => number }
const SYSTEM_CLOCK: Clock = { wall: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1_000_000n) };
/** Sleep shorter than this is ignored: scheduling jitter, not a sleeping machine. */
export const SLEEP_THRESHOLD_MS = 60_000;

/**
 * Taint reasons for one agent session. The monotonic clock stops while the machine sleeps and the wall clock does
 * not, so their difference is time asleep. A session killed after the machine slept was interrupted, not slow.
 */
export function sessionReasons(timedOut: boolean, sleptMs = 0): string[] {
  const slept = sleptMs >= SLEEP_THRESHOLD_MS ? Math.round(sleptMs / 60_000) : 0;
  if (slept && timedOut) return [`interrupted: the machine slept ~${slept} min during this session, then it was killed`];
  if (slept) return [`the machine slept ~${slept} min during this session`];
  return timedOut ? ["timed out"] : [];
}

export async function runClaude(o: { work: string; out: string; budgetUsd: number; model?: string; timeoutMs: number; bin?: string; prompt?: string; name?: string; clock?: Clock }): Promise<{ exitCode: number | null; timedOut: boolean; sleptMs: number; transcript: string }> {
  const clock = o.clock ?? SYSTEM_CLOCK;
  const w0 = clock.wall(), m0 = clock.mono();
  const cfg = join(o.out, "mcp.json");
  writeFileSync(cfg, mcpConfig(o.work));
  const args = claudeArgs({ prompt: o.prompt ?? COLD_START_PROMPT, mcpConfigPath: cfg, budgetUsd: o.budgetUsd, model: o.model });
  const transcript = join(o.out, `${o.name ?? "transcript"}.jsonl`);
  const sink = createWriteStream(transcript);
  const child = spawn(o.bin ?? "claude", args, { cwd: o.work, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  child.stdout.pipe(sink);
  child.stderr.on("data", (d) => process.stderr.write(d));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs);
  const exitCode = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  clearTimeout(timer);
  await new Promise<void>((r) => sink.end(() => r()));
  const sleptMs = Math.max(0, (clock.wall() - w0) - (clock.mono() - m0));
  return { exitCode, timedOut, sleptMs, transcript };
}

// ---------------------------------------------------------------- transcript audit

export interface Audit {
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  /** Reads outside the working copy that actually SUCCEEDED (or never got a result). Any entry taints the run. */
  outside: string[];
  /** Ungranted tools that actually ran (or never got a result). Any entry taints the run. */
  disallowed: string[];
  /** Tools the session was started with that are not on the allowlist: the sandbox itself failed. Taints the run. */
  grantedExtra: string[];
  /** Attempts the sandbox refused (e.g. "No such tool available: Bash"). Informational: nothing was read or run. */
  deniedAttempts: string[];
  model?: string;
  /** From the init event. "none" = the signed-in subscription; anything else means an API key is being billed. */
  apiKeySource?: string;
  /** Claude Code's API-price ESTIMATE (total_cost_usd). On a subscription nothing is billed per token. */
  costUsd?: number; turns?: number; durationMs?: number; sessionId?: string; isError?: boolean;
}

/**
 * realpath that also works for paths that do not exist (an agent may Read a file that is not there). Resolves the
 * deepest existing ancestor and re-appends the rest, so /var/x/new.go and /private/var/x/new.go compare equal on macOS.
 */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* keep walking up */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    rest.push(cur.slice(parent.length + 1));
    cur = parent;
  }
}

/**
 * A model may TRY a tool it was not given; the harness refuses and the transcript shows an errored tool_use. That is
 * the sandbox working, not a breach. Only calls that succeeded (or have no recorded result) count against the run.
 * `work` defaults to the cwd recorded in the transcript's init event.
 */
export function auditTranscript(lines: string[], work?: string): Audit {
  const a: Audit = { toolCalls: {}, toolErrors: {}, outside: [], disallowed: [], grantedExtra: [], deniedAttempts: [] };
  const events: any[] = [];
  for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* skip junk lines */ } }
  const init = events.find((m) => m.type === "system" && m.subtype === "init");
  const root = real(work ?? init?.cwd ?? ".");
  const inside = (p: string) => { const r = real(isAbsolute(p) ? p : join(root, p)); return r === root || r.startsWith(root + "/"); };
  const allowed = new Set([...ALLOWED_BUILTIN, ...MCP_TOOLS]);
  if (init) { a.model = init.model; a.apiKeySource = init.apiKeySource; a.grantedExtra = (init.tools ?? []).filter((t: string) => !allowed.has(t)); }

  const pending = new Map<string, { name: string; outside: string[]; disallowed: boolean }>();
  for (const m of events) {
    if (m.type === "result") { a.costUsd = m.total_cost_usd; a.turns = m.num_turns; a.durationMs = m.duration_ms; a.sessionId = m.session_id; a.isError = m.is_error; }
    for (const c of m.message?.content ?? []) {
      if (c.type === "tool_use") {
        a.toolCalls[c.name] = (a.toolCalls[c.name] ?? 0) + 1;
        const i = c.input ?? {};
        const outside: string[] = [];
        for (const p of [i.file_path, i.path, i.notebook_path, typeof i.pattern === "string" && isAbsolute(i.pattern) ? i.pattern : undefined]) {
          if (typeof p === "string" && p && !inside(p)) outside.push(`${c.name}: ${p}`);
        }
        if (typeof i.pattern === "string" && i.pattern.split("/").includes("..")) outside.push(`${c.name}: ${i.pattern}`);
        pending.set(c.id, { name: c.name, outside, disallowed: !allowed.has(c.name) });
      }
      if (c.type === "tool_result") {
        const call = pending.get(c.tool_use_id);
        if (call) {
          pending.delete(c.tool_use_id);
          if (c.is_error) {
            if (call.disallowed || call.outside.length) a.deniedAttempts.push(call.disallowed ? call.name : call.outside[0]);
          } else {
            if (call.disallowed) a.disallowed.push(call.name);
            a.outside.push(...call.outside);
          }
        }
        if (c.is_error) {
          const txt = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
          const code = /"code":\s*"?([A-Z_]+)/.exec(txt)?.[1] ?? /\\"code\\":\s*\\"([A-Z_]+)/.exec(txt)?.[1] ?? "OTHER";
          a.toolErrors[code] = (a.toolErrors[code] ?? 0) + 1;
        }
      }
    }
  }
  for (const call of pending.values()) {          // no recorded result: cannot prove it was refused, so count it
    if (call.disallowed) a.disallowed.push(call.name);
    a.outside.push(...call.outside);
  }
  return a;
}

// ---------------------------------------------------------------- finish + record

export interface RunRecord {
  repo: string; runId: string; label: string; agent: string; promptHash: string; commit: string; finished: string;
  /** Hash of the golden file this score was computed against. Scores are only comparable at the same hash. */
  goldenHash: string;
  score: Score; final: { rev: number; nodes: number; edges: number; signals: Record<string, number> };
  approver: ApproverStats; audit?: Audit; tainted: boolean; taintReasons: string[]; wallMs: number; timedOut?: boolean; sleptMs?: number;
}

export const goldenHashOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);

export function finishRun(o: { repo: string; runId: string; label: string; agent: string; goldenFile: string; paths: RunPaths; approver: ApproverStats; audit?: Audit; wallMs: number; timedOut?: boolean; sleptMs?: number }): RunRecord {
  const golden = loadGolden(o.goldenFile);
  const map = loadCandidate(o.paths.work);
  const signals: Record<string, number> = {};
  for (const s of computeSignals(o.paths.work, loadMap(o.paths.work))) signals[s.type] = (signals[s.type] ?? 0) + 1;
  const taintReasons = [
    ...(o.audit?.outside.length ? [`read outside working copy: ${o.audit.outside.slice(0, 3).join("; ")}`] : []),
    ...(o.audit?.disallowed.length ? [`ran tools never granted: ${[...new Set(o.audit.disallowed)].join(", ")}`] : []),
    ...(o.audit?.grantedExtra.length ? [`session was started with tools beyond the allowlist: ${o.audit.grantedExtra.join(", ")}`] : []),
    ...sessionReasons(!!o.timedOut, o.sleptMs),
  ];
  const rec: RunRecord = {
    repo: o.repo, runId: o.runId, label: o.label, agent: o.agent, promptHash: PROMPT_HASH, commit: golden.commit, finished: new Date().toISOString(), goldenHash: goldenHashOf(o.goldenFile),
    score: score(golden, map, o.paths.work),
    final: { rev: map.rev, nodes: map.nodes.length, edges: map.edges.length, signals },
    approver: o.approver, audit: o.audit, tainted: taintReasons.length > 0, taintReasons, wallMs: o.wallMs, timedOut: o.timedOut, sleptMs: o.sleptMs,
  };
  writeFileSync(join(o.paths.out, "result.json"), JSON.stringify(rec, null, 2) + "\n");
  cpSync(paths(o.paths.work).dir, join(o.paths.out, "design"), { recursive: true });   // keep the full map + history for audit
  return rec;
}

export const readResult = (file: string): RunRecord => JSON.parse(readFileSync(file, "utf8"));

/** Recompute the audit of a stored run from its transcript (after the audit logic changes). Scores are untouched. */
export function reauditRun(dir: string): RunRecord {
  const file = join(dir, "result.json");
  const rec = readResult(file);
  const audit = auditTranscript(readFileSync(join(dir, "transcript.jsonl"), "utf8").split("\n"));
  const taintReasons = [
    ...(audit.outside.length ? [`read outside working copy: ${audit.outside.slice(0, 3).join("; ")}`] : []),
    ...(audit.disallowed.length ? [`ran tools never granted: ${[...new Set(audit.disallowed)].join(", ")}`] : []),
    ...(audit.grantedExtra.length ? [`session was started with tools beyond the allowlist: ${audit.grantedExtra.join(", ")}`] : []),
    ...sessionReasons(!!rec.timedOut, rec.sleptMs),
  ];
  const next: RunRecord = { ...rec, audit, tainted: taintReasons.length > 0, taintReasons };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * Re-score a stored run against the current golden file, from the map saved with the run. Use after the golden changes.
 * Only `score` and `goldenHash` change; the agent's map, audit and cost are untouched.
 */
export function rescoreRun(dir: string, goldenFile: string, repoRoot: string): RunRecord {
  const file = join(dir, "result.json");
  const rec = readResult(file);
  const map = parse(readFileSync(join(dir, "design", "map.yaml"), "utf8")) as MapDoc;
  const next: RunRecord = { ...rec, score: score(loadGolden(goldenFile), map, repoRoot), goldenHash: goldenHashOf(goldenFile) };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}
