import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MapDoc } from "../../core/src/index.ts";
import { loadGolden, score } from "../score.ts";
import type { Golden } from "../score.ts";

const golden: Golden = {
  repo: "demo", commit: "x",
  nodes: [
    { id: "root", label: "root store", paths: ["internal/store/root"] },
    { id: "leaf", label: "leaf store", paths: ["internal/store/leaf"] },
    { id: "gitbin", label: "git binary", citable: false },
    { id: "tree", label: "tree", paths: ["internal/tree"] },
  ],
  edges: [{ from: "root", to: "leaf" }, { from: "leaf", to: "gitbin" }, { from: "root", to: "tree", optional: true }],
};
const here = new URL("../..", import.meta.url).pathname; // design-loop repo root: real dirs to cite
const mk = (nodes: MapDoc["nodes"], edges: MapDoc["edges"] = []): MapDoc => ({ version: 1, kind: "architecture", title: "t", rev: 1, nodes, edges, groups: [] });
const N = (id: string, path?: string, label = id) => ({ id, label, role: "backend", ...(path ? { cites: [{ path }] } : {}) });

test("matches by what a node cites, not what it is called", () => {
  const r = score(golden, mk([N("a", "core/src"), N("b", "mcp/src")]), here);
  assert.equal(r.nodes.matched, 0);
  const g2: Golden = { ...golden, nodes: [{ id: "core", label: "Core", paths: ["core/src"] }, { id: "m", label: "MCP", paths: ["mcp"] }], edges: [] };
  const r2 = score(g2, mk([N("totally-different-name", "core/src"), N("x", "mcp/src/server.ts")]), here);
  assert.equal(r2.nodes.recall, 1, "exact path and a more specific path both match");
});

test("each candidate node can satisfy only one golden node", () => {
  const g2: Golden = { ...golden, nodes: [{ id: "a", label: "A", paths: ["core/src"] }, { id: "b", label: "B", paths: ["core/src/flow.ts"] }], edges: [] };
  const r = score(g2, mk([N("one", "core/src")]), here);
  assert.equal(r.nodes.matched, 1, "a single broad node must not claim two golden components");
});

test("name fallback finds uncitable nodes; extras are reported as unjudged, not wrong", () => {
  const r = score(golden, mk([N("root", "internal/store/root"), N("leaf", "internal/store/leaf"), N("gitbin", undefined, "git binary"), N("zzz", "core")]), here);
  assert.equal(r.nodes.recall, 0.667);        // 2 of 3 citable nodes (tree is missing); gitbin is uncitable and scored by name
  assert.deepEqual(r.nodes.missed, ["tree"]);
  assert.deepEqual(r.nodes.byName, ["gitbin"]);
  assert.deepEqual(r.extras.ids, ["zzz"]);
});

test("edges: direction matters, optional edges are not required, unmatched endpoints are called out", () => {
  const nodes = [N("root", "internal/store/root"), N("leaf", "internal/store/leaf"), N("gitbin", undefined, "git binary")];
  const ok = score(golden, mk(nodes, [{ id: "e1", from: "root", to: "leaf" }, { id: "e2", from: "leaf", to: "gitbin" }]), here);
  assert.equal(ok.edges.recall, 1); assert.equal(ok.edges.scored, 2);
  const rev = score(golden, mk(nodes, [{ id: "e1", from: "leaf", to: "root" }]), here);
  assert.equal(rev.edges.reversed, 1); assert.equal(rev.edges.hit, 0);
  assert.ok(rev.edges.missed.some((m) => m.includes("(reversed)")));
  const none = score(golden, mk([N("root", "internal/store/root")]), here);
  assert.ok(none.edges.missed.some((m) => m.includes("endpoint unmatched")));
  assert.equal(none.edges.evaluable, 0);
});

test("cite validity is deterministic and independent of the golden", () => {
  const r = score(golden, mk([N("real", "core/src"), { ...N("fake", "nope/missing"), cites: [{ path: "nope/missing" }, { path: "core/src/flow.ts" }] }, N("uncited")]), here);
  assert.equal(r.cites.total, 3); assert.equal(r.cites.valid, 2);
  assert.equal(r.cites.groundedNodes, 2); assert.equal(r.cites.nodes, 3);
});

// Oracle: a candidate built straight from the golden must score 100%. Proves golden and scorer agree,
// and that every golden path really exists in the stripped copy. Skipped when the bench folder is absent.
const BENCH = process.env.DESIGN_BENCH ?? join(homedir(), "Projects/asadani/tools/design-loop-bench");
for (const repo of ["gopass", "swagger-php"]) {
  const gf = join(BENCH, "golden", `${repo}.yaml`), rr = join(BENCH, "stripped", repo);
  test(`oracle: ${repo} golden scores 100% against its own stripped copy`, { skip: !existsSync(gf) || !existsSync(rr) }, () => {
    const g = loadGolden(gf);
    const nodes = g.nodes.map((n) => ({ id: n.id, label: n.label, role: "backend", ...(n.paths ? { cites: n.paths.map((path) => ({ path })) } : {}) }));
    const edges = g.edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to }));
    const r = score(g, mk(nodes, edges), rr);
    assert.equal(r.nodes.recall, 1, `missed: ${r.nodes.missed}`);
    assert.equal(r.edges.recall, 1, `missed: ${r.edges.missed}`);
    assert.equal(r.cites.validity, 1);
    assert.equal(r.extras.count, 0);
  });
}

// ---- scorer v2: tiers, undirected edges, lenient (abstraction-tolerant) edges
const g2: Golden = {
  repo: "demo", commit: "x",
  nodes: [
    { id: "leaf", label: "leaf", paths: ["core/src"] },
    { id: "backend", label: "backend", paths: ["mcp"] },
    { id: "gitfs", label: "gitfs", paths: ["mcp/src"] },        // child of backend by path
    { id: "util", label: "util", paths: ["viewer"] },            // no edges: peripheral
  ],
  edges: [{ from: "leaf", to: "gitfs" }, { from: "gitfs", to: "backend", undirected: true }],
};

test("tiers: core = touched by a golden edge, peripheral = not; explicit tier overrides; both reported", () => {
  const r = score(g2, mk([N("a", "core/src"), N("u", "viewer")]), here);
  assert.deepEqual([r.nodes.byTier.core.citable, r.nodes.byTier.peripheral.citable], [3, 1]);
  assert.equal(r.nodes.byTier.peripheral.recall, 1);              // util matched
  assert.equal(r.nodes.byTier.core.matched, 1);                   // only leaf
  assert.deepEqual(r.nodes.byTier.core.missed.sort(), ["backend", "gitfs"]);
  const forced: Golden = { ...g2, nodes: g2.nodes.map((n) => (n.id === "util" ? { ...n, tier: "core" as const } : n)) };
  assert.equal(score(forced, mk([]), here).nodes.byTier.core.citable, 4);
  assert.equal(r.scorerVersion, 2);
});

test("undirected edges count in either direction and are never reported as reversed", () => {
  const nodes = [N("g", "mcp/src"), N("b", "mcp")];
  const fwd = score(g2, mk(nodes, [{ id: "e", from: "g", to: "b" }]), here);
  const back = score(g2, mk(nodes, [{ id: "e", from: "b", to: "g" }]), here);
  assert.equal(fwd.edges.hit, 1); assert.equal(back.edges.hit, 1);
  assert.equal(back.edges.reversed, 0);
  const directed: Golden = { ...g2, edges: [{ from: "gitfs", to: "backend" }] };
  const rev = score(directed, mk(nodes, [{ id: "e", from: "b", to: "g" }]), here);
  assert.equal(rev.edges.hit, 0); assert.equal(rev.edges.reversed, 1, "a DIRECTED golden edge still reports reversal");
});

test("lenient: an edge to a parent satisfies an edge to its child; strict stays strict", () => {
  // golden: leaf -> gitfs. The agent drew leaf -> backend (the parent package), the abstraction the doc's text describes.
  const nodes = [N("leaf", "core/src"), N("backend", "mcp"), N("gitfs", "mcp/src")];
  const abstractOnly = score(g2, mk(nodes, [{ id: "e", from: "leaf", to: "backend" }]), here);
  assert.equal(abstractOnly.edges.hit, 0, "strict: leaf -> backend is not leaf -> gitfs");
  assert.equal(abstractOnly.edges.hitLenient, 1, "lenient: a parent of the endpoint stands in for it");
  // the reverse direction must not satisfy a directed golden edge, even leniently
  const wrongWay = score(g2, mk(nodes, [{ id: "e", from: "backend", to: "leaf" }]), here);
  assert.equal(wrongWay.edges.hitLenient, 0);
  // unrelated nodes never count: leaf -> viewer is not close to leaf -> gitfs
  const unrelated = score(g2, mk([...nodes, N("v", "viewer")], [{ id: "e", from: "leaf", to: "v" }]), here);
  assert.equal(unrelated.edges.hitLenient, 0);
});

test("lenient is never below strict, and equals the oracle on a perfect map", () => {
  for (const edges of [[], [{ id: "e", from: "leaf", to: "gitfs" }], [{ id: "e", from: "gitfs", to: "leaf" }], [{ id: "e", from: "leaf", to: "backend" }]]) {
    const r = score(g2, mk([N("leaf", "core/src"), N("backend", "mcp"), N("gitfs", "mcp/src")], edges), here);
    assert.ok(r.edges.hitLenient >= r.edges.hit, JSON.stringify(edges));
  }
  const perfect = score(g2, mk([N("leaf", "core/src"), N("backend", "mcp"), N("gitfs", "mcp/src")], [{ id: "e1", from: "leaf", to: "gitfs" }, { id: "e2", from: "gitfs", to: "backend" }]), here);
  assert.equal(perfect.edges.recall, 1); assert.equal(perfect.edges.recallLenient, 1);
});
