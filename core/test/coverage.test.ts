import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply, baseline, computeSignals, initMap, loadCoverage, loadMap, propose, saveCoverage, uncovered } from "../src/index.ts";
import type { CoverageConfig } from "../src/index.ts";

function repo(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "dl-cov-"));
  for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), "x\n"); }
  initMap(root, "architecture", "t");
  return { root, done: () => rmSync(root, { recursive: true }) };
}
const cfg = (over: Partial<CoverageConfig> = {}): CoverageConfig => ({ roots: ["internal"], extensions: [".go"], acknowledged: [], ...over });
const mapWith = (root: string, cites: string[]) => {
  if (!cites.length) return loadMap(root);
  apply(root, propose(root, { base_rev: loadMap(root).rev, source: { kind: "import", summary: "s" }, ops: cites.map((path, i) => ({ op: "add_node", node: { id: `n${loadMap(root).nodes.length + i}`, label: path, role: "backend", status: "stable", cites: [{ path }] } })) }).id);
  return loadMap(root);
};

test("finds source folders no cite covers, grouping sub-folders under their topmost uncovered folder", () => {
  const r = repo(["internal/store/a.go", "internal/svc/s.go", "internal/svc/crypto/c.go", "internal/svc/crypto/c_test.go",
    "internal/docsonly/README.md", "internal/onlytests/x_test.go", "internal/store/testdata/t.go", "cmd/main.go"]);
  const m = mapWith(r.root, ["internal/store"]);
  assert.deepEqual(uncovered(r.root, m, cfg()), [{ path: "internal/svc", folders: 2, files: 2 }],
    "tests, testdata, non-source and folders outside the roots are ignored; svc + svc/crypto are one finding");
  r.done();
});

test("a folder is covered by a cite on it, above it, or on a file directly inside it", () => {
  const r = repo(["internal/a/x.go", "internal/b/deep/y.go", "internal/c/z.go", "internal/c/sub/w.go"]);
  const m = mapWith(r.root, ["internal/a", "internal/b", "internal/c/z.go"]);
  assert.deepEqual(uncovered(r.root, m, cfg()).map((u) => u.path), ["internal/c/sub"], "a file cite covers its own folder only");
  r.done();
});

test("acknowledged folders (and everything inside them) are ignored; a name prefix is not a path prefix", () => {
  const r = repo(["internal/old/x.go", "internal/old/sub/y.go", "internal/older/z.go"]);
  const m = mapWith(r.root, []);
  assert.deepEqual(uncovered(r.root, m, cfg({ acknowledged: ["internal/old"] })).map((u) => u.path), ["internal/older"]);
  r.done();
});

test("symlinked folders are never followed", () => {
  const r = repo(["internal/real/x.go"]);
  symlinkSync(join(r.root, "internal/real"), join(r.root, "internal/link"));
  const m = mapWith(r.root, ["internal/real"]);
  assert.deepEqual(uncovered(r.root, m, cfg()), []);
  r.done();
});

test("signal flow: enabling acknowledges today's gaps; new code raises one 'uncovered' signal; a node citing it clears it", () => {
  const r = repo(["internal/store/a.go", "internal/legacy/l.go"]);
  mapWith(r.root, ["internal/store"]);
  assert.ok(!computeSignals(r.root).some((s) => s.type === "uncovered"), "coverage off: no signal");
  const c = cfg();
  saveCoverage(r.root, { ...c, acknowledged: baseline(r.root, loadMap(r.root), c) });
  assert.deepEqual(loadCoverage(r.root)!.acknowledged, ["internal/legacy"]);
  assert.deepEqual(computeSignals(r.root), [], "nothing new yet");

  mkdirSync(join(r.root, "internal/secrets/crypto"), { recursive: true });
  writeFileSync(join(r.root, "internal/secrets/s.go"), "x\n"); writeFileSync(join(r.root, "internal/secrets/crypto/c.go"), "x\n");
  const s = computeSignals(r.root);
  assert.equal(s.length, 1);
  assert.deepEqual({ ...s[0], detail: undefined }, { node: "", path: "internal/secrets", type: "uncovered", severity: "warn", detail: undefined });
  assert.match(s[0].detail, /2 source files in 2 folders/);

  mapWith(r.root, ["internal/secrets"]);
  assert.deepEqual(computeSignals(r.root), [], "mapping the code resolves it");
  r.done();
});

test("saveCoverage refuses roots outside the repo and empty config", () => {
  const r = repo([]);
  assert.throws(() => saveCoverage(r.root, cfg({ roots: ["../etc"] })), /inside the repo/);
  assert.throws(() => saveCoverage(r.root, cfg({ roots: ["/etc"] })), /inside the repo/);
  assert.throws(() => saveCoverage(r.root, cfg({ extensions: [] })), /at least one/);
  assert.ok(!existsSync(join(r.root, ".design", "coverage.yaml")));
  r.done();
});

test("root \".\" watches the whole repo with clean relative paths", () => {
  const r = repo(["main.go", "internal/a/x.go", "c/y.go"]);
  const m = mapWith(r.root, ["internal/a"]);
  assert.deepEqual(uncovered(r.root, m, cfg({ roots: ["."] })).map((u) => u.path), [".", "c"]);
  assert.deepEqual(uncovered(r.root, m, cfg({ roots: ["./"], acknowledged: ["."] })).map((u) => u.path), ["c"], "acknowledging the root folder does not hide its sub-folders");
  r.done();
});
