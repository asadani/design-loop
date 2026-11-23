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
