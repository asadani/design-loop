import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DesignError } from "./types.ts";
import type { Cite, HistoryEntry, MapDoc, Op, Proposal, Source } from "./types.ts";
import { applyOps } from "./ops.ts";
import { diffMaps } from "./diff.ts";
import type { MapDiff } from "./diff.ts";
import { appendHistory, listHistory, listProposals, loadMap, loadPins, loadProposal, nextProposalId, saveMap, saveProposal } from "./store.ts";

export const SKIP_DIR = /^(\.|node_modules$|vendor$|testdata$|__tests?__$|tests?$)/;
export const SKIP_FILE = /(^\.|_test\.|\.test\.|\.spec\.|Test\.php$)/;

/** Sorted relative paths of non-test, non-hidden files under a directory. Symlinks are never followed. `skip` holds relative paths to leave out. */
function listTree(abs: string, rel = "", skip: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(abs, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink() || skip.has(r)) continue;
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) out.push(...listTree(abs, r, skip)); }
    else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(r);
  }
  return out.sort();
}

const normPath = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Paths inside a folder cite that some cite in the map points at more specifically. A folder cite does not watch
 * code another cite already watches: otherwise a change inside a child component (age under backend) would flag the
 * parent too, and stay flagged after the child is re-anchored.
 */
export function nestedCites(map: MapDoc, c: Cite): string[] {
  const base = normPath(c.path);
  const all = map.nodes.flatMap((n) => (n.cites ?? []).map((x) => normPath(x.path)));
  return [...new Set(all.filter((p) => p !== base && p.startsWith(base + "/")))].sort();
}

/**
 * Hash of a cited region. A file hashes its (trailing-whitespace-normalised) lines. A directory
 * hashes its file LISTING, not contents: architecture drift is files appearing, vanishing or moving,
 * and hashing contents would flag a large package on every edit.
 */
export function citeHash(root: string, c: Cite, exclude: string[] = []): string | null {
  const f = join(root, c.path);
  if (!existsSync(f) || lstatSync(f).isSymbolicLink()) return null;
  if (statSync(f).isDirectory()) {
    const base = normPath(c.path);
    const skip = new Set(exclude.map(normPath).filter((p) => p.startsWith(base + "/")).map((p) => p.slice(base.length + 1)));
    return "sha256:" + createHash("sha256").update(listTree(f, "", skip).join("\n")).digest("hex").slice(0, 16);
  }
  let lines = readFileSync(f, "utf8").split("\n").map((l) => l.replace(/\s+$/, ""));
  if (c.lines) lines = lines.slice(c.lines[0] - 1, c.lines[1]);
  return "sha256:" + createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

function anchor(root: string, map: MapDoc): MapDoc {
  for (const n of map.nodes) for (const c of n.cites ?? []) if (!c.hash) { const h = citeHash(root, c, nestedCites(map, c)); if (h) c.hash = h; }
  return map;
}

/**
 * Build the next map's cite hashes. Hashes are server-owned: any cite a proposal sets is re-anchored from the code,
 * whatever hash the proposal carried (an agent echoing map_read output must not freeze a stale hash). A folder cite
 * whose set of nested cites changed is re-hashed only if it was clean before, so a new child node does not make its
 * parent look drifted, and real drift is never cleared as a side effect.
 */
function rehash(root: string, prev: MapDoc, next: MapDoc, ops: Op[]): MapDoc {
  const set = new Set(ops.flatMap((o) => (o.op === "add_node" ? [o.node.id] : o.op === "update_node" && o.set.cites ? [o.id] : [])));
  for (const n of next.nodes) if (set.has(n.id)) n.cites = n.cites?.map(({ hash: _h, ...rest }) => rest);
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  for (const n of next.nodes) {
    if (set.has(n.id)) continue;
    for (const c of n.cites ?? []) {
      if (!c.hash) continue;
      const was = before.get(n.id)?.cites?.find((x) => x.path === c.path);
      if (!was) continue;
      const oldEx = nestedCites(prev, c), newEx = nestedCites(next, c);
      if (oldEx.join("\n") === newEx.join("\n")) continue;
      if (citeHash(root, c, oldEx) === c.hash) { const h = citeHash(root, c, newEx); if (h) c.hash = h; }
    }
  }
  return anchor(root, next);
}

/** Agent entry point. Fails fast (nothing saved) so the agent can fix and retry. */
export function propose(root: string, input: { base_rev: number; source: Source; ops: Op[] }): Proposal {
  const map = loadMap(root);
  if (input.base_rev !== map.rev) throw new DesignError("STALE", `base_rev ${input.base_rev} is behind current rev ${map.rev}; re-read the map`);
  if (!input.ops.length) throw new DesignError("INVALID", "proposal has no ops");
  if (!input.source?.summary) throw new DesignError("INVALID", "source.summary is required");
  applyOps(map, input.ops, loadPins(root)); // dry run: throws on any violation
  const p: Proposal = { id: nextProposalId(root), base_rev: input.base_rev, created: new Date().toISOString(), source: input.source, ops: input.ops, state: "pending", decided_by: null };
  saveProposal(root, p);
  return p;
}

/** Human decision. Applies a pending proposal and appends history. */
export function apply(root: string, id: number): MapDoc {
  const p = loadProposal(root, id);
  if (p.state !== "pending") throw new DesignError("NOT_PENDING", `proposal ${id} is ${p.state}`);
  const map = loadMap(root);
  if (p.base_rev !== map.rev) throw new DesignError("STALE", `proposal ${id} is based on rev ${p.base_rev}, map is at ${map.rev}; rebase it`);
  const next = rehash(root, map, applyOps(map, p.ops, loadPins(root)), p.ops);
  next.rev = map.rev + 1;
  const entry: HistoryEntry = { rev: next.rev, applied: new Date().toISOString(), proposal: id, source: p.source, ops: p.ops, decided_by: "human" };
  appendHistory(root, entry); // first: if this fails the map is untouched
  saveMap(root, next);
  saveProposal(root, { ...p, state: "applied", decided_by: "human" });
  return next;
}

export function reject(root: string, id: number, reason?: string): Proposal {
  const p = loadProposal(root, id);
  if (p.state !== "pending") throw new DesignError("NOT_PENDING", `proposal ${id} is ${p.state}`);
  const r: Proposal = { ...p, state: "rejected", decided_by: "human", ...(reason ? { reason } : {}) };
  saveProposal(root, r);
  return r;
}

/** Move a stale pending proposal onto the current rev if its ops still apply cleanly. */
export function rebase(root: string, id: number): Proposal {
  const p = loadProposal(root, id);
  if (p.state !== "pending") throw new DesignError("NOT_PENDING", `proposal ${id} is ${p.state}`);
  const map = loadMap(root);
  applyOps(map, p.ops, loadPins(root)); // throws if the ops no longer fit
  const r = { ...p, base_rev: map.rev };
  saveProposal(root, r);
  return r;
}

/** Reconstruct the map at a past rev by replaying history from the rev-0 snapshot. */
export function mapAtRev(root: string, rev: number): MapDoc {
  const hist = listHistory(root);
  const first = hist[0];
  if (!first?.snapshot) throw new DesignError("NOT_FOUND", "history has no rev-0 snapshot");
  if (rev < 0 || rev > (hist.at(-1)?.rev ?? 0)) throw new DesignError("NOT_FOUND", `rev ${rev} does not exist`);
  let m = structuredClone(first.snapshot);
  for (const e of hist.slice(1)) {
    if (e.rev > rev) break;
    m = applyOps(m, e.ops);
    m.rev = e.rev;
  }
  return m;
}

export function diffRevs(root: string, from: number, to: number): MapDiff {
  return diffMaps(mapAtRev(root, from), mapAtRev(root, to));
}

/** What the agent and the viewer ask first: where are we, and what is waiting. */
export function status(root: string) {
  const map = loadMap(root);
  const pending = listProposals(root).filter((p) => p.state === "pending");
  return { rev: map.rev, kind: map.kind, title: map.title, pending: pending.map((p) => ({ id: p.id, base_rev: p.base_rev, stale: p.base_rev !== map.rev, summary: p.source.summary })) };
}
