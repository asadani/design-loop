import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { apply, computeSignals, DesignError, diffRevs, initMap, listHistory, loadMap, loadPins, mapAtRev, paths, propose, reject, rebase, savePins, status, validateMap } from "../src/index.ts";
import type { Op } from "../src/index.ts";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "dl-"));
  initMap(root, "architecture", "Checkout");
  return root;
}
const src = (summary: string) => ({ kind: "agent-turn" as const, session: "s1", turn: 1, summary });
const addApi: Op[] = [
  { op: "add_node", node: { id: "api", label: "API", role: "backend", status: "in-progress" } },
  { op: "add_node", node: { id: "db", label: "Postgres", role: "database", status: "planned" } },
  { op: "add_edge", edge: { id: "e1", from: "api", to: "db", kind: "sync" } },
];
const code = (e: unknown): string => (e as DesignError).code;

test("propose does not change the map; apply does, and records history", () => {
  const root = repo();
  const p = propose(root, { base_rev: 0, source: src("first sketch"), ops: addApi });
  assert.equal(loadMap(root).nodes.length, 0, "map untouched by propose");
  assert.equal(p.state, "pending");
  const m = apply(root, p.id);
  assert.equal(m.rev, 1);
  assert.equal(m.nodes.length, 2);
  const h = listHistory(root);
  assert.deepEqual(h.map((e) => e.rev), [0, 1]);
  assert.equal(h[1].source.summary, "first sketch");
  rmSync(root, { recursive: true });
});

test("stale base_rev is refused at propose and at apply", () => {
  const root = repo();
  const a = propose(root, { base_rev: 0, source: src("a"), ops: addApi });
  const b = propose(root, { base_rev: 0, source: src("b"), ops: [{ op: "add_node", node: { id: "ui", label: "UI", role: "frontend" } }] });
  apply(root, a.id);
  assert.throws(() => apply(root, b.id), (e) => code(e) === "STALE");
  assert.throws(() => propose(root, { base_rev: 0, source: src("c"), ops: addApi }), (e) => code(e) === "STALE");
  const r = rebase(root, b.id);
  assert.equal(r.base_rev, 1);
  assert.equal(apply(root, b.id).rev, 2);
  rmSync(root, { recursive: true });
});

test("a human-locked label cannot be changed by the agent; other fields can", () => {
  const root = repo();
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops: addApi }).id);
  const pins = loadPins(root);
  pins.locked_labels.push("api");
  pins.pins.api = { x: 240, y: 120 };
  savePins(root, pins);
  assert.throws(() => propose(root, { base_rev: 1, source: src("rename"), ops: [{ op: "update_node", id: "api", set: { label: "Gateway" } }] }), (e) => code(e) === "PIN_VIOLATION");
  const ok = propose(root, { base_rev: 1, source: src("status"), ops: [{ op: "update_node", id: "api", set: { status: "stable" } }] });
  assert.equal(apply(root, ok.id).nodes[0].status, "stable");
  assert.deepEqual(loadPins(root).pins.api, { x: 240, y: 120 }, "pins survive applies");
  rmSync(root, { recursive: true });
});

test("layout fields and unknown fields can never enter the map", () => {
  const root = repo();
  const bad = [{ op: "add_node", node: { id: "x", label: "X", role: "backend", x: 10, y: 20 } }] as unknown as Op[];
  assert.throws(() => propose(root, { base_rev: 0, source: src("pos"), ops: bad }), (e) => code(e) === "INVALID");
  const badSet = [{ op: "update_node", id: "api", set: { x: 1 } }] as unknown as Op[];
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops: addApi }).id);
  assert.throws(() => propose(root, { base_rev: 1, source: src("pos"), ops: badSet }), (e) => code(e) === "INVALID");
  rmSync(root, { recursive: true });
});

test("role must come from the closed vocabulary for the map kind", () => {
  const root = repo();
  const ops: Op[] = [{ op: "add_node", node: { id: "x", label: "X", role: "decision" } }];
  assert.throws(() => propose(root, { base_rev: 0, source: src("role"), ops }), (e) => code(e) === "INVALID");
  rmSync(root, { recursive: true });
});

test("removing a node that still has edges is refused with the blockers named", () => {
  const root = repo();
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops: addApi }).id);
  try {
    propose(root, { base_rev: 1, source: src("rm"), ops: [{ op: "remove_node", id: "db" }] });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(code(e), "INVALID");
    assert.deepEqual((e as DesignError).details, ["e1"]);
  }
  rmSync(root, { recursive: true });
});

test("rejected proposals never apply and keep their reason", () => {
  const root = repo();
  const p = propose(root, { base_rev: 0, source: src("meh"), ops: addApi });
  reject(root, p.id, "wrong db");
  assert.throws(() => apply(root, p.id), (e) => code(e) === "NOT_PENDING");
  assert.equal(parse(readFileSync(join(paths(root).proposals, "0001.yaml"), "utf8")).reason, "wrong db");
  assert.equal(status(root).pending.length, 0);
  rmSync(root, { recursive: true });
});

test("history replays to any past rev and diffs between revs", () => {
  const root = repo();
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops: addApi }).id);
  apply(root, propose(root, { base_rev: 1, source: src("swap db"), ops: [{ op: "update_node", id: "db", set: { label: "DynamoDB", status: "in-progress" } }] }).id);
  assert.equal(mapAtRev(root, 0).nodes.length, 0);
  assert.equal(mapAtRev(root, 1).nodes[1].label, "Postgres");
  assert.equal(mapAtRev(root, 2).nodes[1].label, "DynamoDB");
  const d = diffRevs(root, 1, 2);
  assert.deepEqual(d.nodes.changed, [{ id: "db", fields: ["label", "status"] }]);
  assert.equal(diffRevs(root, 2, 2).empty, true);
  assert.throws(() => mapAtRev(root, 9), (e) => code(e) === "NOT_FOUND");
  rmSync(root, { recursive: true });
});

test("signals: cite drift, missing files, uncited nodes", () => {
  const root = repo();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/api.ts"), "line1\nline2\nline3\n");
  const ops: Op[] = [
    { op: "add_node", node: { id: "api", label: "API", role: "backend", status: "stable", cites: [{ path: "src/api.ts", lines: [1, 2] }] } },
    { op: "add_node", node: { id: "gone", label: "Gone", role: "backend", status: "stable", cites: [{ path: "src/gone.ts" }] } },
    { op: "add_node", node: { id: "bare", label: "Bare", role: "backend", status: "in-progress" } },
  ];
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops }).id);
  assert.match(loadMap(root).nodes[0].cites![0].hash!, /^sha256:/, "hash anchored on apply");
  let sig = computeSignals(root).map((s) => `${s.node}:${s.type}`);
  assert.deepEqual(sig, ["gone:cite-missing", "bare:no-cite"]);
  writeFileSync(join(root, "src/api.ts"), "line1 CHANGED\nline2\nline3\n");
  sig = computeSignals(root).map((s) => `${s.node}:${s.type}`);
  assert.ok(sig.includes("api:cite-moved"));
  writeFileSync(join(root, "src/api.ts"), "line1\nline2   \nline3\nline4 added outside cited range\n");
  assert.ok(!computeSignals(root).some((s) => s.node === "api"), "edits outside cited lines and trailing whitespace are not drift");
  rmSync(root, { recursive: true });
});

test("stale-planned fires after 5 revs of a node staying planned", () => {
  const root = repo();
  apply(root, propose(root, { base_rev: 0, source: src("seed"), ops: [{ op: "add_node", node: { id: "q", label: "Queue", role: "messagebus", status: "planned" } }] }).id);
  for (let i = 1; i <= 5; i++) apply(root, propose(root, { base_rev: i, source: src(`n${i}`), ops: [{ op: "add_node", node: { id: `n${i}`, label: `N${i}`, role: "backend", status: "planned" } }] }).id);
  const types = computeSignals(root).filter((s) => s.node === "q").map((s) => s.type);
  assert.deepEqual(types, ["stale-planned"]);
  rmSync(root, { recursive: true });
});

test("validateMap rejects unsafe cite paths", () => {
  const m = { version: 1, kind: "architecture", title: "t", rev: 0, edges: [], groups: [], nodes: [{ id: "a", label: "A", role: "backend", cites: [{ path: "../etc/passwd" }] }] };
  assert.match(validateMap(m).join("\n"), /relative and inside the repo/);
  m.nodes[0].cites = [{ path: "/etc/passwd" }];
  assert.match(validateMap(m).join("\n"), /relative and inside the repo/);
});
