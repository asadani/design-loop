import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { events, gitState, goImports, goldenAtBase, judge, materialize, nodeFor, replaySignals, timeline } from "../replay.ts";
import type { ReplayConfig } from "../replay.ts";
import { loadMap } from "../../core/src/index.ts";

test("goImports: blocks, single, aliased, dot and blank imports; ignores comments and code below", () => {
  const src = `// Package b does things.
package b

/* import "ex.com/m/commented" */
import "ex.com/m/a"
import x "ex.com/m/aliased"
import (
\t"fmt"
\t_ "ex.com/m/blank" // registers
\t. "ex.com/m/dot"
\t// "ex.com/m/linecomment"
)

func f() { s := "import \\"ex.com/m/instring\\"" }
`;
  assert.deepEqual(goImports(src).sort(), ["ex.com/m/a", "ex.com/m/aliased", "ex.com/m/blank", "ex.com/m/dot", "fmt"]);
});

test("nodeFor picks the most specific covering node", () => {
  const nodes = [{ id: "backend", paths: ["internal/backend"] }, { id: "gitfs", paths: ["internal/backend/storage/gitfs"] }];
  assert.equal(nodeFor("internal/backend/storage/gitfs/sub", nodes), "gitfs");
  assert.equal(nodeFor("internal/backend/storage/gogit", nodes), "backend");
  assert.equal(nodeFor("internal/backendx", nodes), null, "a name prefix is not a path prefix");
});

// ---- a tiny Go repo with known history
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dl-replay-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const put = (f: string, body: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); };
  const commit = (m: string) => { g("add", "-A"); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
  g("init", "-q");
  put("go.mod", "module ex.com/m\n");
  put("a/a.go", "package a\n");
  put("b/b.go", 'package b\nimport "ex.com/m/a"\n');
  put("b/b_test.go", 'package b\nimport "ex.com/m/t"\n');               // test imports never count
  put("docs/ARCH.md", "a and b, the architecture\n");
  const c0 = commit("base");
  put("c/c.go", "package c\n");                                           // new package no node covers
  put("b/b.go", 'package b\nimport (\n\t"ex.com/m/a"\n\t"ex.com/m/c"\n)\n');  // b gains a dependency, b's file listing unchanged
  const c1 = commit("add c");
  put("a/sub/s.go", 'package sub\nimport "ex.com/m/a"\n');                // new package inside node A
  const c2 = commit("add a/sub");
  put("a/a.go", "package a\n// edited\n"); put("README.md", "hi\n");     // no architectural change
  const c3 = commit("edit");
  put("a/extra.go", "package a\n");                                       // listing changes, architecture does not
  const c4 = commit("extra file");
  return { dir, c: [c0, c1, c2, c3, c4], done: () => rmSync(dir, { recursive: true, force: true }) };
}
const NODES = [{ id: "na", label: "A", paths: ["a"] }, { id: "nb", label: "B", paths: ["b"] }];

test("gitState reads packages and in-module imports from git objects, skipping tests", () => {
  const r = repo();
  const s0 = gitState(r.dir, r.c[0]);
  assert.deepEqual([...s0.packages].sort(), ["a", "b"]);
  assert.deepEqual([...s0.pkgEdges], ["b\ta"]);
  const s2 = gitState(r.dir, r.c[2]);
  assert.deepEqual([...s2.pkgEdges].sort(), ["a/sub\ta", "b\ta", "b\tc"]);
  r.done();
});

test("events: new packages (covered or not) and component-level dependency changes", () => {
  const r = repo();
  const [s0, s1, s2, s3] = r.c.slice(0, 4).map((c) => gitState(r.dir, c));
  assert.deepEqual(events(s0, s1, NODES), { newPkgs: [{ pkg: "c", node: null }], removedPkgs: [], edgesAdded: [{ from: "nb", to: "?c" }], edgesRemoved: [] });
  const e12 = events(s1, s2, NODES);
  assert.deepEqual(e12.newPkgs, [{ pkg: "a/sub", node: "na" }]);
  assert.deepEqual(e12.edgesAdded, [], "a/sub -> a is inside node A, not a component edge");
  assert.deepEqual(events(s2, s3, NODES), { newPkgs: [], removedPkgs: [], edgesAdded: [], edgesRemoved: [] });
  r.done();
});

test("judge separates noticed, silent (touches the map), outside (no node involved) and noise", () => {
  const evs = { newPkgs: [{ pkg: "c", node: null }, { pkg: "a/sub", node: "na" }], removedPkgs: [], edgesAdded: [{ from: "nb", to: "?c" }, { from: "?c", to: "?d" }], edgesRemoved: [] };
  const sig = (node: string) => ({ node, type: "cite-moved", severity: "warn" as const, detail: "" });
  const j = judge(evs, [sig("na"), sig("z")], [...NODES, { id: "z", label: "Z", paths: ["z"] }]);
  assert.deepEqual(j.noticed, ["new package a/sub (in na)"]);
  assert.deepEqual(j.silent, ["+ dependency nb -> ?c"]);
  assert.deepEqual(j.outside, ["new package c (no node covers it)", "+ dependency ?c -> ?d"]);
  assert.deepEqual(j.noise, ["z"]);
});

test("materialize swaps the tree but keeps .design, strips paths and never writes .git", () => {
  const r = repo();
  const out = mkdtempSync(join(tmpdir(), "dl-mat-"));
  materialize(r.dir, r.c[0], out, ["docs"]);
  mkdirSync(join(out, ".design")); writeFileSync(join(out, ".design", "keep"), "x");
  const res = materialize(r.dir, r.c[2], out, ["docs", "nope"]);
  assert.ok(existsSync(join(out, "a/sub/s.go")));
  assert.ok(!existsSync(join(out, "docs")), "stripped");
  assert.ok(!existsSync(join(out, ".git")));
  assert.equal(readFileSync(join(out, ".design", "keep"), "utf8"), "x");
  assert.deepEqual(res, { removed: ["docs"], missing: ["nope"] });
  materialize(r.dir, r.c[0], out, []);
  assert.ok(!existsSync(join(out, "a/sub")), "files from a later commit do not linger");
  rmSync(out, { recursive: true }); r.done();
});

test("replaySignals end to end: a covered new package is noticed, an uncovered one is outside, a pure import change is silent, edits are quiet", () => {
  const r = repo();
  const bench = mkdtempSync(join(tmpdir(), "dl-bench-"));
  writeFileSync(join(bench, "golden.yaml"), stringify({ repo: "m", commit: r.c[4], nodes: [...NODES, { id: "gone", label: "gone", paths: ["later"] }], edges: [{ from: "nb", to: "na" }, { from: "nb", to: "gone" }] }));
  const cfg: ReplayConfig = {
    repo: "m", source: r.dir, golden: join(bench, "golden.yaml"), base: r.c[0], strip: ["docs"], dropAtBase: ["gone"],
    checkpoints: [
      { commit: r.c[1], label: "add c", expect: "must" }, { commit: r.c[2], label: "add a/sub", expect: "may" },
      { commit: r.c[3], label: "edit", expect: "control" }, { commit: r.c[4], label: "extra file", expect: "noise" },
    ],
  };
  const rep = replaySignals(cfg);
  const [c1, c2, c3, c4] = rep.checkpoints;
  assert.deepEqual(c1.outside, ["new package c (no node covers it)"]);
  assert.deepEqual(c1.silent, ["+ dependency nb -> ?c"], "b's listing did not change, so nothing flags B");
  assert.deepEqual(c2.noticed, ["new package a/sub (in na)"]);
  assert.deepEqual([c3.signals, c3.noise], [[], []], "a control interval raises nothing");
  assert.deepEqual(c4.noise, ["na"], "a new file with no architectural change is noise");
  assert.ok(!existsSync(join(rep.work, "docs")));
  // the base map honoured dropAtBase and re-anchoring went through the real proposal flow
  const map = loadMap(rep.work);
  assert.equal(map.rev, 3, "rev 1 = base map; revs 2 and 3 = re-anchors after the two checkpoints that flagged na");
  assert.ok(!map.nodes.some((n) => n.id === "gone"));
  assert.equal(goldenAtBase({ repo: "m", commit: "x", nodes: [...NODES, { id: "gone", label: "g" }], edges: [{ from: "nb", to: "gone" }] }, ["gone"]).edges.length, 0);
  rmSync(rep.work, { recursive: true }); rmSync(bench, { recursive: true }); r.done();
});

test("timeline reports per-commit events along first-parent history", () => {
  const r = repo();
  const t = timeline(r.dir, r.c[0], r.c[4], NODES);
  assert.deepEqual(t.map((x) => x.subject), ["add c", "add a/sub", "edit", "extra file"]);
  assert.deepEqual(t.map((x) => x.events.newPkgs.length), [1, 1, 0, 0]);
  r.done();
});

test("replaySignals with coverage: a new package no node covers is noticed, then acknowledged so it does not repeat", () => {
  const r = repo();
  const bench = mkdtempSync(join(tmpdir(), "dl-bench-"));
  writeFileSync(join(bench, "golden.yaml"), stringify({ repo: "m", commit: r.c[4], nodes: NODES, edges: [{ from: "nb", to: "na" }] }));
  const cfg: ReplayConfig = {
    repo: "m", source: r.dir, golden: join(bench, "golden.yaml"), base: r.c[0], strip: ["docs"], coverage: { roots: ["."], extensions: [".go"] },
    checkpoints: [{ commit: r.c[1], label: "add c", expect: "must" }, { commit: r.c[2], label: "add a/sub", expect: "may" }, { commit: r.c[3], label: "edit", expect: "control" }],
  };
  const off = replaySignals(cfg, { coverage: false });
  const on = replaySignals(cfg, { coverage: true });
  assert.equal(off.coverage, false); assert.equal(on.coverage, true);
  assert.deepEqual(off.checkpoints[0].noticed, []);
  assert.deepEqual(on.checkpoints[0].noticed.sort(), ["+ dependency nb -> ?c", "new package c (no node covers it)"]);
  assert.deepEqual(on.checkpoints[0].signals.map((g) => [g.type, g.path]), [["uncovered", "c"]]);
  assert.deepEqual(on.checkpoints[1].signals.map((g) => g.type), ["cite-moved"], "c is not reported again; only na's new sub-package");
  assert.deepEqual(on.checkpoints[2].signals, [], "control: nothing");
  for (const x of [off, on]) rmSync(x.work, { recursive: true });
  rmSync(bench, { recursive: true }); r.done();
});
