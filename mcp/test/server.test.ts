import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { apply, initMap, listProposals, loadMap, loadPins, savePins } from "../../core/src/index.ts";
import { createServer } from "../src/server.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "dl-mcp-"));
  initMap(root, "architecture", "Checkout");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { root, client, call, done: () => rmSync(root, { recursive: true }) };
}
const seedOps = [
  { op: "add_node", node: { id: "api", label: "API", role: "backend", status: "in-progress" } },
  { op: "add_node", node: { id: "db", label: "Postgres", role: "database" } },
  { op: "add_edge", edge: { id: "e1", from: "api", to: "db" } },
];
const src = (summary: string) => ({ kind: "agent-turn", session: "s1", turn: 3, summary });

test("exposes exactly the read/propose tools and nothing that decides", async () => {
  const t = await setup();
  const names = (await t.client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["map_diff", "map_explain_node", "map_history", "map_propose", "map_read", "map_status"]);
  t.done();
});

test("propose over MCP saves a pending proposal and leaves the map unchanged", async () => {
  const t = await setup();
  const r = await t.call("map_propose", { base_rev: 0, source: src("sketch checkout"), ops: seedOps });
  assert.equal(r.isError, false);
  assert.equal(r.data.state, "pending");
  assert.equal(loadMap(t.root).nodes.length, 0);
  assert.equal(listProposals(t.root).length, 1);
  const s = await t.call("map_status");
  assert.equal(s.data.pending[0].summary, "sketch checkout");
  t.done();
});

test("errors come back as structured isError results the agent can act on", async () => {
  const t = await setup();
  const stale = await t.call("map_propose", { base_rev: 4, source: src("x"), ops: seedOps });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.code, "STALE");
  const badRole = await t.call("map_propose", { base_rev: 0, source: src("x"), ops: [{ op: "add_node", node: { id: "z", label: "Z", role: "decision" } }] });
  assert.equal(badRole.data.code, "INVALID");
  assert.equal(listProposals(t.root).length, 0, "nothing saved on failure");
  t.done();
});

test("layout fields and human provenance are rejected at the protocol boundary", async () => {
  const t = await setup();
  const pos = await t.client.callTool({ name: "map_propose", arguments: { base_rev: 0, source: src("x"), ops: [{ op: "add_node", node: { id: "z", label: "Z", role: "backend", x: 5, y: 9 } }] } }) as { isError?: boolean };
  assert.equal(pos.isError, true);
  const human = await t.client.callTool({ name: "map_propose", arguments: { base_rev: 0, source: { kind: "human", summary: "me" }, ops: seedOps } }) as { isError?: boolean };
  assert.equal(human.isError, true);
  assert.equal(listProposals(t.root).length, 0);
  t.done();
});

test("locked labels are visible in map_read and enforced on propose", async () => {
  const t = await setup();
  const p = await t.call("map_propose", { base_rev: 0, source: src("seed"), ops: seedOps });
  apply(t.root, p.data.proposal);
  const pins = loadPins(t.root); pins.locked_labels.push("api"); pins.pins.api = { x: 1, y: 2 }; savePins(t.root, pins);
  const read = await t.call("map_read");
  assert.deepEqual(read.data.locked_labels, ["api"]);
  assert.equal(JSON.stringify(read.data).includes('"x"'), false, "positions are not exposed to the agent");
  const r = await t.call("map_propose", { base_rev: 1, source: src("rename"), ops: [{ op: "update_node", id: "api", set: { label: "Gateway" } }] });
  assert.equal(r.data.code, "PIN_VIOLATION");
  t.done();
});

test("history, diff and explain_node reflect applied changes", async () => {
  const t = await setup();
  apply(t.root, (await t.call("map_propose", { base_rev: 0, source: src("seed"), ops: seedOps })).data.proposal);
  apply(t.root, (await t.call("map_propose", { base_rev: 1, source: src("move to dynamo"), ops: [{ op: "update_node", id: "db", set: { label: "DynamoDB" } }] })).data.proposal);
  const h = await t.call("map_history", { limit: 1 });
  assert.deepEqual(h.data.map((e: { summary: string }) => e.summary), ["move to dynamo"]);
  const d = await t.call("map_diff", { from: 1, to: 2 });
  assert.deepEqual(d.data.nodes.changed, [{ id: "db", fields: ["label"] }]);
  const pend = await t.call("map_propose", { base_rev: 2, source: src("add queue"), ops: [{ op: "add_edge", edge: { id: "e2", from: "api", to: "db" } }] });
  const x = await t.call("map_explain_node", { id: "db" });
  assert.equal(x.data.node.label, "DynamoDB");
  assert.deepEqual(x.data.history.map((e: { rev: number }) => e.rev), [1, 2]);
  assert.deepEqual(x.data.pending.map((p: { id: number }) => p.id), [pend.data.proposal]);
  assert.equal(x.data.edges_in[0].id, "e1");
  assert.equal((await t.call("map_explain_node", { id: "nope" })).data.code, "NOT_FOUND");
  t.done();
});
