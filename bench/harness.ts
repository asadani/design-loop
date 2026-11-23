import { spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { apply, computeSignals, DesignError, initMap, listProposals, loadMap, paths, rebase, reject } from "../core/src/index.ts";
import type { Op } from "../core/src/index.ts";
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

export async function runClaude(o: { work: string; out: string; budgetUsd: number; model?: string; timeoutMs: number; bin?: string }): Promise<{ exitCode: number | null; timedOut: boolean; transcript: string }> {
  const cfg = join(o.out, "mcp.json");
  writeFileSync(cfg, mcpConfig(o.work));
  const args = claudeArgs({ prompt: COLD_START_PROMPT, mcpConfigPath: cfg, budgetUsd: o.budgetUsd, model: o.model });
  const transcript = join(o.out, "transcript.jsonl");
  const sink = createWriteStream(transcript);
  const child = spawn(o.bin ?? "claude", args, { cwd: o.work, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  child.stdout.pipe(sink);
  child.stderr.on("data", (d) => process.stderr.write(d));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs);
  const exitCode = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  clearTimeout(timer);
  await new Promise<void>((r) => sink.end(() => r()));
  return { exitCode, timedOut, transcript };
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
  if (init) { a.model = init.model; a.grantedExtra = (init.tools ?? []).filter((t: string) => !allowed.has(t)); }

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
  score: Score; final: { rev: number; nodes: number; edges: number; signals: Record<string, number> };
  approver: ApproverStats; audit?: Audit; tainted: boolean; taintReasons: string[]; wallMs: number; timedOut?: boolean;
}

export function finishRun(o: { repo: string; runId: string; label: string; agent: string; goldenFile: string; paths: RunPaths; approver: ApproverStats; audit?: Audit; wallMs: number; timedOut?: boolean }): RunRecord {
  const golden = loadGolden(o.goldenFile);
  const map = loadCandidate(o.paths.work);
  const signals: Record<string, number> = {};
  for (const s of computeSignals(o.paths.work, loadMap(o.paths.work))) signals[s.type] = (signals[s.type] ?? 0) + 1;
  const taintReasons = [
    ...(o.audit?.outside.length ? [`read outside working copy: ${o.audit.outside.slice(0, 3).join("; ")}`] : []),
    ...(o.audit?.disallowed.length ? [`ran tools never granted: ${[...new Set(o.audit.disallowed)].join(", ")}`] : []),
    ...(o.audit?.grantedExtra.length ? [`session was started with tools beyond the allowlist: ${o.audit.grantedExtra.join(", ")}`] : []),
    ...(o.timedOut ? ["timed out"] : []),
  ];
  const rec: RunRecord = {
    repo: o.repo, runId: o.runId, label: o.label, agent: o.agent, promptHash: PROMPT_HASH, commit: golden.commit, finished: new Date().toISOString(),
    score: score(golden, map, o.paths.work),
    final: { rev: map.rev, nodes: map.nodes.length, edges: map.edges.length, signals },
    approver: o.approver, audit: o.audit, tainted: taintReasons.length > 0, taintReasons, wallMs: o.wallMs, timedOut: o.timedOut,
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
    ...(rec.timedOut ? ["timed out"] : []),
  ];
  const next: RunRecord = { ...rec, audit, tainted: taintReasons.length > 0, taintReasons };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}
