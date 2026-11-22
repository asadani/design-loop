import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMap, loadMap, loadPins, listProposals, propose } from "../../core/src/index.ts";
import type { Op } from "../../core/src/index.ts";
import { run } from "../src/cli.ts";
import type { Env } from "../src/cli.ts";

function harness(opts: { tty?: boolean; answer?: boolean; stdin?: string; init?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dl-cli-"));
  if (opts.init !== false) initMap(root, "architecture", "Checkout");
  let out = "", err = "", asked = 0;
  const env: Env = {
    root, tty: opts.tty ?? true,
    out: (s) => { out += s; }, err: (s) => { err += s; },
    ask: async () => { asked++; return opts.answer ?? true; },
    stdin: async () => opts.stdin ?? "",
  };
  return { root, env, o: () => out, e: () => err, asked: () => asked, done: () => rmSync(root, { recursive: true }) };
}
const ops: Op[] = [
  { op: "add_node", node: { id: "api", label: "API", role: "backend", status: "in-progress", cites: [{ path: "src/api.ts" }] } },
  { op: "add_node", node: { id: "db", label: "Postgres", role: "database" } },
  { op: "add_edge", edge: { id: "e1", from: "api", to: "db" } },
];
const seed = (root: string, base = 0) => propose(root, { base_rev: base, source: { kind: "agent-turn", session: "s1", turn: 2, summary: "sketch checkout" }, ops }).id;

test("apply: shows the change, needs a human, then applies", async () => {
  const h = harness(); const id = seed(h.root);
  assert.equal(await run(["apply", String(id)], h.env), 0);
  assert.match(h.o(), /\+ node api "API"/);
  assert.match(h.o(), /applied; map is now rev 1/);
  assert.equal(loadMap(h.root).rev, 1);
  h.done();
});

test("without a TTY every decision command is refused and nothing changes", async () => {
  const h = harness({ tty: false }); const id = seed(h.root);
  for (const argv of [["apply", String(id)], ["reject", String(id)], ["pin", "api", "1", "2"], ["lock", "api"], ["rebase", String(id)], ["init", "state", "X"]]) {
    if (argv[0] === "pin" || argv[0] === "lock") { /* needs the node to exist first */ }
    const code = await run(argv, h.env);
    assert.notEqual(code, 0, argv.join(" "));
  }
  assert.match(h.e(), /needs an interactive terminal/);
  assert.equal(h.asked(), 0, "never even prompts");
  assert.equal(loadMap(h.root).rev, 0);
  assert.equal(listProposals(h.root)[0].state, "pending");
  assert.deepEqual(loadPins(h.root).locked_labels, []);
  h.done();
});

test("answering no cancels", async () => {
  const h = harness({ answer: false }); const id = seed(h.root);
  assert.equal(await run(["apply", String(id)], h.env), 1);
  assert.match(h.o(), /cancelled/);
  assert.equal(loadMap(h.root).rev, 0);
  h.done();
});

test("reject records the reason; review and status read it back", async () => {
  const h = harness(); const id = seed(h.root);
  await run(["status"], h.env);
  assert.match(h.o(), new RegExp(`pending #${id}: sketch checkout`));
  assert.equal(await run(["reject", String(id), "wrong", "db"], h.env), 0);
  assert.equal(listProposals(h.root)[0].reason, "wrong db");
  assert.equal(await run(["apply", String(id)], h.env), 1);
  assert.match(h.e(), /NOT_PENDING/);
  h.done();
});

test("stale proposals are flagged and can be rebased by a human", async () => {
  const h = harness(); const a = seed(h.root);
  const b = propose(h.root, { base_rev: 0, source: { kind: "agent-turn", summary: "ui" }, ops: [{ op: "add_node", node: { id: "ui", label: "UI", role: "frontend" } }] }).id;
  await run(["apply", String(a)], h.env);
  assert.equal(await run(["apply", String(b)], h.env), 1);
  assert.match(h.e(), /STALE/);
  await run(["review", String(b)], h.env);
  assert.match(h.o(), /STALE, rebase first/);
  assert.equal(await run(["rebase", String(b)], h.env), 0);
  assert.equal(await run(["apply", String(b)], h.env), 0);
  assert.equal(loadMap(h.root).rev, 2);
  h.done();
});

test("pin, lock, unlock and unpin edit only the human channel", async () => {
  const h = harness(); await run(["apply", String(seed(h.root))], h.env);
  assert.equal(await run(["pin", "api", "240", "120"], h.env), 0);
  assert.equal(await run(["lock", "api"], h.env), 0);
  assert.deepEqual(loadPins(h.root).pins.api, { x: 240, y: 120 });
  assert.deepEqual(loadPins(h.root).locked_labels, ["api"]);
  assert.equal(await run(["pin", "ghost", "1", "1"], h.env), 1);
  assert.equal(await run(["pin", "api", "-4", "x"], h.env), 1);
  await run(["unlock", "api"], h.env); await run(["unpin", "api"], h.env);
  assert.deepEqual(loadPins(h.root).locked_labels, []);
  assert.equal(loadPins(h.root).pins.api, undefined);
  assert.equal(loadMap(h.root).rev, 1, "map itself untouched by pin commands");
  h.done();
});

test("diff and history read past revisions", async () => {
  const h = harness(); await run(["apply", String(seed(h.root))], h.env);
  await run(["diff", "0", "1"], h.env);
  assert.match(h.o(), /\+ node api/); assert.match(h.o(), /\+ edge e1/);
  await run(["history"], h.env);
  assert.match(h.o(), /rev 1 .* sketch checkout/);
  h.done();
});

test("init refuses to overwrite and rejects unknown kinds", async () => {
  const h = harness();
  assert.equal(await run(["init", "architecture", "Again"], h.env), 1);
  assert.match(h.e(), /EXISTS/);
  assert.equal(await run(["init", "mindmap", "X"], h.env), 1);
  h.done();
});

test("stop hook: silent when nothing drifted, blocks once when cited code changed", async () => {
  const h = harness({ stdin: "{}" });
  mkdirSync(join(h.root, "src")); writeFileSync(join(h.root, "src/api.ts"), "v1\n");
  await run(["apply", String(seed(h.root))], h.env);
  assert.equal(await run(["hook", "stop"], h.env), 0);
  assert.equal(h.o().includes("block"), false, "no drift -> no block");
  writeFileSync(join(h.root, "src/api.ts"), "v2\n");
  let out = ""; const env2 = { ...h.env, out: (s: string) => { out += s; } };
  assert.equal(await run(["hook", "stop"], env2), 0);
  const j = JSON.parse(out);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /api: cite-moved/);
  // the second Stop of the same turn must not block again
  let out2 = ""; const env3 = { ...env2, out: (s: string) => { out2 += s; }, stdin: async () => JSON.stringify({ stop_hook_active: true }) };
  assert.equal(await run(["hook", "stop"], env3), 0);
  assert.equal(out2, "");
  h.done();
});

test("stop hook is silent in a repo with no design map", async () => {
  const h = harness({ init: false });
  assert.equal(await run(["hook", "stop"], h.env), 0);
  assert.equal(h.o(), ""); assert.equal(h.e(), "");
  h.done();
});

test("unknown command exits 2 with help", async () => {
  const h = harness();
  assert.equal(await run(["frobnicate"], h.env), 2);
  assert.match(h.e(), /Decide \(human only/);
  h.done();
});
