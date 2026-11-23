import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMap, loadMap, loadPins, propose, listProposals } from "../../core/src/index.ts";
import type { Op } from "../../core/src/index.ts";
import { startViewer } from "../src/server.ts";
// @ts-expect-error plain JS module shared with the browser
import { layout, route, clampZoom, fitZoom, NODE_W, NODE_H } from "../public/layout.js";

const TOKEN = "t".repeat(48);
const ops: Op[] = [
  { op: "add_node", node: { id: "api", label: "<img src=x onerror=alert(1)>", role: "backend" } },
  { op: "add_node", node: { id: "db", label: "DB", role: "database" } },
  { op: "add_edge", edge: { id: "e1", from: "api", to: "db" } },
];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "dl-view-"));
  initMap(root, "architecture", "Checkout");
  const v = await startViewer(root, TOKEN);
  const base = new URL(v.url).origin;
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) =>
    fetch(base + path, { ...init, headers: { ...(init.token === null ? {} : { "x-dl-token": init.token ?? TOKEN }), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as object) } });
  const post = (path: string, body: object, extra: RequestInit = {}) => call(path, { method: "POST", body: JSON.stringify(body), ...extra });
  return { root, v, base, call, post, done: async () => { await v.close(); rmSync(root, { recursive: true }); } };
}
const seed = (root: string) => propose(root, { base_rev: 0, source: { kind: "agent-turn", summary: "sketch" }, ops }).id;

test("every api route needs the token; pages are served with a strict CSP", async () => {
  const t = await setup();
  assert.equal((await t.call("/api/state", { token: null })).status, 401);
  assert.equal((await t.call("/api/state", { token: "wrong" + "x".repeat(43) })).status, 401);
  assert.equal((await t.post("/api/apply", { id: 1 }, { headers: { "x-dl-token": "" } })).status, 401);
  const page = await t.call("/", { token: null });
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy")!;
  assert.match(await page.clone().text(), /<title>design-loop<\/title>/, "serves real html, not serialised bytes");
  assert.match(page.headers.get("content-type")!, /text\/html/);
  for (const [path, type, needle] of [["/app.js", "javascript", "import { layout"], ["/layout.js", "javascript", "export function layout"], ["/style.css", "css", "--paper"]]) {
    const r = await t.call(path, { token: null });
    assert.match(r.headers.get("content-type")!, new RegExp(type)); assert.match(await r.text(), new RegExp(needle), path);
  }
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline/);
  await t.done();
});

test("rejects foreign Host and Origin headers (DNS rebinding and CSRF)", async () => {
  const t = await setup();
  const evil = await fetch(t.base + "/api/state", { headers: { "x-dl-token": TOKEN, host: "evil.example" } }).catch(() => null);
  // fetch cannot always override Host; use a raw request to be sure
  const { request } = await import("node:http");
  const status = await new Promise<number>((ok) => { const r = request({ host: "127.0.0.1", port: new URL(t.base).port, path: "/api/state", headers: { host: "evil.example", "x-dl-token": TOKEN } }, (res) => { res.resume(); ok(res.statusCode!); }); r.end(); });
  assert.equal(status, 403);
  void evil;
  const id = seed(t.root);
  const r = await t.post("/api/apply", { id }, { headers: { origin: "http://evil.example", "x-dl-token": TOKEN, "content-type": "application/json" } });
  assert.equal(r.status, 403);
  assert.equal(loadMap(t.root).rev, 0);
  await t.done();
});

test("state, preview, apply, rev view and live event", async () => {
  const t = await setup(); const id = seed(t.root);
  const s = await (await t.call("/api/state")).json() as { proposals: { id: number; stale: boolean }[]; map: { rev: number } };
  assert.equal(s.proposals[0].id, id); assert.equal(s.proposals[0].stale, false);
  const pv = await (await t.call(`/api/preview?id=${id}`)).json() as { diff: { nodes: { added: string[] } }; map: { nodes: unknown[] } };
  assert.deepEqual(pv.diff.nodes.added, ["api", "db"]);
  assert.equal(loadMap(t.root).nodes.length, 0, "preview applies nothing");

  const ac = new AbortController();
  const ev = await fetch(`${t.base}/api/events?t=${TOKEN}`, { signal: ac.signal });
  const reader = ev.body!.getReader();
  const gotChanged = (async () => { let buf = ""; for (;;) { const { value, done } = await reader.read(); if (done) return false; buf += new TextDecoder().decode(value); if (buf.includes("event: changed")) return true; } })();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await t.post("/api/apply", { id })).status, 200);
  assert.equal(await Promise.race([gotChanged, new Promise((r) => setTimeout(() => r("timeout"), 3000))]), true, "page is told to refresh");
  ac.abort();

  assert.equal(loadMap(t.root).rev, 1);
  const rv = await (await t.call("/api/rev?n=1")).json() as { diff: { nodes: { added: string[] } } };
  assert.deepEqual(rv.diff.nodes.added, ["api", "db"]);
  assert.equal((await t.call("/api/rev?n=9")).status, 404);
  await t.done();
});

test("decisions map to sensible statuses; stale and bad input are refused", async () => {
  const t = await setup(); const a = seed(t.root);
  const b = propose(t.root, { base_rev: 0, source: { kind: "agent-turn", summary: "ui" }, ops: [{ op: "add_node", node: { id: "ui", label: "UI", role: "frontend" } }] }).id;
  await t.post("/api/apply", { id: a });
  assert.equal((await t.post("/api/apply", { id: b })).status, 409);
  assert.equal((await t.post("/api/rebase", { id: b })).status, 200);
  assert.equal((await t.post("/api/apply", { id: b })).status, 200);
  assert.equal((await t.post("/api/apply", { id: b })).status, 409, "already applied");
  assert.equal((await t.post("/api/apply", { id: "1" })).status, 400);
  assert.equal((await t.post("/api/apply", { id: 999 })).status, 404);
  const bad = await t.call("/api/apply", { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await t.call("/api/apply")).status, 405);
  await t.done();
});

test("pin, lock, unlock, unpin through the human channel", async () => {
  const t = await setup(); await t.post("/api/apply", { id: seed(t.root) });
  assert.equal((await t.post("/api/pin", { id: "api", x: 240.4, y: 120 })).status, 200);
  assert.deepEqual(loadPins(t.root).pins.api, { x: 240, y: 120 });
  assert.equal((await t.post("/api/pin", { id: "api", x: "a", y: 1 })).status, 400);
  assert.equal((await t.post("/api/pin", { id: "ghost", x: 1, y: 1 })).status, 404);
  await t.post("/api/lock", { id: "api" });
  assert.deepEqual(loadPins(t.root).locked_labels, ["api"]);
  await t.post("/api/unlock", { id: "api" }); await t.post("/api/unpin", { id: "api" });
  assert.deepEqual(loadPins(t.root), { pins: {}, hidden: [], locked_labels: [] });
  assert.equal(listProposals(t.root)[0].state, "applied");
  await t.done();
});

test("layout: columns follow edges, pins win, cycles terminate", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
  const { pos } = layout(nodes, edges);
  assert.ok(pos.a.x < pos.b.x && pos.b.x < pos.c.x);
  assert.equal(layout(nodes, edges, { b: { x: 500, y: 7 } }).pos.b.pinned, true);
  assert.deepEqual([layout(nodes, edges, { b: { x: 500, y: 7 } }).pos.b.x, layout(nodes, edges, { b: { x: 500, y: 7 } }).pos.b.y], [500, 7]);
  const cyc = layout(nodes, [...edges, { from: "c", to: "a" }, { from: "a", to: "a" }]);
  assert.equal(Object.keys(cyc.pos).length, 3);
  assert.equal(layout([], []).width > 0, true);
});

test("route: straight when level, rounded elbow otherwise, loops around when backwards", () => {
  const a = { x: 0, y: 0 }, level = { x: 300, y: 0 }, low = { x: 300, y: 200 }, back = { x: 0, y: 200 };
  assert.match(route(a, level).d, /^M\d+,\d+ H\d+$/);
  assert.match(route(a, low).d, /Q/);
  assert.match(route(a, back).d, /V.*H.*V/);
  assert.ok(NODE_W > 0 && NODE_H > 0);
});

test("zoom: clamped, never enlarges past 100% when fitting, and survives bad input", () => {
  assert.equal(clampZoom(99), 3); assert.equal(clampZoom(0.01), 0.25); assert.equal(clampZoom(NaN), 1); assert.equal(clampZoom(1.5), 1.5);
  assert.equal(fitZoom(400, 300, 900, 700), 1, "small maps stay at natural size");
  assert.ok(Math.abs(fitZoom(2300, 800, 900, 700) - 900 / 2300) < 1e-9, "wide maps shrink to the box width");
  assert.ok(Math.abs(fitZoom(800, 2300, 900, 700) - 700 / 2300) < 1e-9, "tall maps shrink to the box height");
  assert.equal(fitZoom(0, 0, 900, 700), 1); assert.equal(fitZoom(500, 500, 0, 0), 1);
  assert.equal(fitZoom(100000, 100000, 900, 700), 0.25, "never below the minimum zoom");
});

test("page ships the zoom controls and the new-change styling", async () => {
  const t = await setup();
  const html = await (await t.call("/", { token: null })).text();
  for (const id of ["z-in", "z-out", "z-fit", "z-reset", "scroller", "legend"]) assert.match(html, new RegExp(`id="${id}"`), id);
  const css = await (await t.call("/style.css", { token: null })).text();
  assert.match(css, /--new:/); assert.match(css, /\.node\.new rect\.box/); assert.match(css, /\.edge\.new/);
  assert.doesNotMatch(css, /#canvas \{ width: 100%/, "the map must not be force-fitted to the window");
  await t.done();
});
