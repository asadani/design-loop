import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeSignals, DesignError, diffRevs, EDGE_KINDS, KINDS, listHistory, listProposals, loadMap, loadPins, propose, ROLES, STATUSES, status } from "../../core/src/index.ts";

/**
 * The agent's only write path. By design this server exposes NO tool that applies,
 * rejects, or touches pins: those are human decisions made in the viewer or CLI.
 */

const cite = z.object({ path: z.string(), lines: z.tuple([z.number().int(), z.number().int()]).optional() }).strict();
const nodeShape = {
  id: z.string(), label: z.string(), role: z.string(),
  status: z.enum(STATUSES).optional(), cites: z.array(cite).optional(), note: z.string().optional(),
};
const node = z.object(nodeShape).strict();
const edge = z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string().optional(), kind: z.enum(EDGE_KINDS).optional() }).strict();
const group = z.object({ id: z.string(), label: z.string(), members: z.array(z.string()) }).strict();
const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node }).strict(),
  z.object({ op: z.literal("update_node"), id: z.string(), set: node.omit({ id: true }).partial().strict() }).strict(),
  z.object({ op: z.literal("remove_node"), id: z.string() }).strict(),
  z.object({ op: z.literal("add_edge"), edge }).strict(),
  z.object({ op: z.literal("update_edge"), id: z.string(), set: edge.omit({ id: true }).partial().strict() }).strict(),
  z.object({ op: z.literal("remove_edge"), id: z.string() }).strict(),
  z.object({ op: z.literal("add_group"), group }).strict(),
  z.object({ op: z.literal("update_group"), id: z.string(), set: group.omit({ id: true }).partial().strict() }).strict(),
  z.object({ op: z.literal("remove_group"), id: z.string() }).strict(),
]);

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown): Result => {
  if (e instanceof DesignError) return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: e.code, message: e.message, details: e.details }, null, 2) }] };
  throw e;
};
const guard = <A>(fn: (a: A) => unknown) => (a: A): Result => { try { return ok(fn(a)); } catch (e) { return fail(e); } };

export function createServer(root: string): McpServer {
  const server = new McpServer({ name: "design-loop", version: "0.0.0" }, {
    instructions:
      "design-loop keeps a typed design map of this repository. Call map_status first. " +
      "Read the map with map_read, then change it only with map_propose using the revision you read. " +
      "Proposals are never applied by you: a human reviews and applies them. " +
      "Never put layout (x, y, positions) in a proposal; layout is the human's. " +
      "Nodes listed in locked_labels must not be renamed. Cite code with `cites` so drift can be detected.",
  });

  server.registerTool("map_status", {
    title: "Map status",
    description: "Current revision, map kind, pending proposals (flagging stale ones), and a count of drift signals by severity. Call this first.",
    inputSchema: {},
  }, guard(() => {
    const s = status(root);
    const by = { high: 0, warn: 0, info: 0 };
    for (const g of computeSignals(root)) by[g.severity]++;
    return { ...s, signals: by };
  }));

  server.registerTool("map_read", {
    title: "Read the map",
    description: `Return the current map (nodes, edges, groups, rev) and the node ids whose labels a human has locked. Roles are a closed set per kind: ${KINDS.map((k) => `${k}: ${ROLES[k].join("/")}`).join("; ")}.`,
    inputSchema: {},
  }, guard(() => ({ map: loadMap(root), locked_labels: loadPins(root).locked_labels })));

  server.registerTool("map_propose", {
    title: "Propose a change",
    description:
      "Propose granular changes to the map. base_rev must equal the rev you just read, or the call fails with STALE. " +
      "The proposal is validated immediately; if it is invalid nothing is saved and the error says why. " +
      "A valid proposal is saved as pending for a human to apply. source.summary says why, in one line.",
    inputSchema: {
      base_rev: z.number().int().min(0),
      source: z.object({ kind: z.enum(["agent-turn", "git-diff"]), session: z.string().optional(), turn: z.number().int().optional(), summary: z.string().min(1) }).strict(),
      ops: z.array(op).min(1),
    },
  }, guard((a: { base_rev: number; source: { kind: "agent-turn" | "git-diff"; session?: string; turn?: number; summary: string }; ops: unknown[] }) => {
    const p = propose(root, a as Parameters<typeof propose>[1]);
    return { proposal: p.id, state: p.state, base_rev: p.base_rev, note: "Pending human approval; the map has not changed." };
  }));

  server.registerTool("map_history", {
    title: "Map history",
    description: "Applied changes, newest last: rev, when, why (source summary), and how many ops. Use limit to see only the most recent.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, guard((a: { limit?: number }) => {
    const h = listHistory(root).map((e) => ({ rev: e.rev, applied: e.applied, proposal: e.proposal, session: e.source.session, turn: e.source.turn, summary: e.source.summary, ops: e.ops.length }));
    return a.limit ? h.slice(-a.limit) : h;
  }));

  server.registerTool("map_diff", {
    title: "Diff two revisions",
    description: "What changed between two revisions: node, edge and group ids added, removed, or changed (with the changed field names).",
    inputSchema: { from: z.number().int().min(0), to: z.number().int().min(0) },
  }, guard((a: { from: number; to: number }) => diffRevs(root, a.from, a.to)));

  server.registerTool("map_explain_node", {
    title: "Explain a node",
    description: "Everything known about one node: its definition, edges in and out, drift signals, the history entries that touched it, and pending proposals that would change it.",
    inputSchema: { id: z.string() },
  }, guard((a: { id: string }) => {
    const map = loadMap(root);
    const n = map.nodes.find((x) => x.id === a.id);
    if (!n) throw new DesignError("NOT_FOUND", `node "${a.id}" does not exist`);
    const touches = (o: { op: string; id?: string; node?: { id: string }; edge?: { from: string; to: string } }) =>
      o.id === a.id || o.node?.id === a.id || o.edge?.from === a.id || o.edge?.to === a.id;
    return {
      node: n,
      edges_out: map.edges.filter((e) => e.from === a.id),
      edges_in: map.edges.filter((e) => e.to === a.id),
      groups: map.groups.filter((g) => g.members.includes(a.id)).map((g) => g.id),
      locked_label: loadPins(root).locked_labels.includes(a.id),
      signals: computeSignals(root, map).filter((s) => s.node === a.id),
      history: listHistory(root).filter((e) => e.ops.some(touches)).map((e) => ({ rev: e.rev, summary: e.source.summary })),
      pending: listProposals(root).filter((p) => p.state === "pending" && p.ops.some(touches)).map((p) => ({ id: p.id, summary: p.source.summary })),
    };
  }));

  return server;
}
