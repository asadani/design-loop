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

/** Sorted relative paths of non-test, non-hidden files under a directory. Symlinks are never followed. */
function listTree(abs: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(abs, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) out.push(...listTree(abs, r)); }
    else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(r);
  }
  return out.sort();
}

/**
 * Hash of a cited region. A file hashes its (trailing-whitespace-normalised) lines. A directory
 * hashes its file LISTING, not contents: architecture drift is files appearing, vanishing or moving,
 * and hashing contents would flag a large package on every edit.
 */
export function citeHash(root: string, c: Cite): string | null {
  const f = join(root, c.path);
  if (!existsSync(f) || lstatSync(f).isSymbolicLink()) return null;
  if (statSync(f).isDirectory()) {
    return "sha256:" + createHash("sha256").update(listTree(f).join("\n")).digest("hex").slice(0, 16);
  }
  let lines = readFileSync(f, "utf8").split("\n").map((l) => l.replace(/\s+$/, ""));
  if (c.lines) lines = lines.slice(c.lines[0] - 1, c.lines[1]);
  return "sha256:" + createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

function anchor(root: string, map: MapDoc): MapDoc {
  for (const n of map.nodes) for (const c of n.cites ?? []) if (!c.hash) { const h = citeHash(root, c); if (h) c.hash = h; }
  return map;
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
  const next = anchor(root, applyOps(map, p.ops, loadPins(root)));
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
