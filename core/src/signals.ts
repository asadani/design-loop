import { writeFileSync } from "node:fs";
import type { MapDoc } from "./types.ts";
import { citeHash, mapAtRev, nestedCites } from "./flow.ts";
import { loadMap, paths } from "./store.ts";
import { loadCoverage, uncovered } from "./coverage.ts";

export type Severity = "info" | "warn" | "high";
/** `node` is empty for signals about code rather than a node (type "uncovered"); `path` then names the code. */
export interface Signal { node: string; type: string; severity: Severity; detail: string; path?: string }
export const STALE_PLANNED_REVS = 5;

/** Deterministic checks only. No model judgement. */
export function computeSignals(root: string, map: MapDoc = loadMap(root)): Signal[] {
  const out: Signal[] = [];
  for (const n of map.nodes) {
    if (n.status && n.status !== "planned" && n.status !== "deprecated" && !n.cites?.length) {
      out.push({ node: n.id, type: "no-cite", severity: "info", detail: `${n.status} node has no code reference` });
    }
    for (const c of n.cites ?? []) {
      const now = citeHash(root, c, nestedCites(map, c));
      if (now === null) out.push({ node: n.id, type: "cite-missing", severity: "high", detail: `${c.path} does not exist` });
      else if (c.hash && c.hash !== now) out.push({ node: n.id, type: "cite-moved", severity: "warn", detail: `${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""} changed since it was anchored` });
    }
  }
  // stale-planned: still "planned" N revs after first appearing as planned
  const since = new Map<string, number>();
  for (let r = 0; r <= map.rev; r++) {
    const m = mapAtRev(root, r);
    for (const n of m.nodes) { if (n.status === "planned") { if (!since.has(n.id)) since.set(n.id, r); } else since.delete(n.id); }
    for (const id of [...since.keys()]) if (!m.nodes.some((n) => n.id === id)) since.delete(id);
  }
  for (const [id, r] of since) {
    if (map.rev - r >= STALE_PLANNED_REVS) out.push({ node: id, type: "stale-planned", severity: "info", detail: `planned since rev ${r}, ${map.rev - r} revs ago` });
  }
  // uncovered: source folders under the configured roots that no cite covers and no human acknowledged
  const cov = loadCoverage(root);
  if (cov) for (const u of uncovered(root, map, cov)) {
    out.push({ node: "", path: u.path, type: "uncovered", severity: "warn", detail: `${u.path}: ${u.files} source file${u.files === 1 ? "" : "s"} in ${u.folders} folder${u.folders === 1 ? "" : "s"} that no node covers` });
  }
  const rank = { high: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.node.localeCompare(b.node) || (a.path ?? "").localeCompare(b.path ?? ""));
}

export function writeSignals(root: string) {
  const map = loadMap(root);
  const signals = computeSignals(root, map);
  writeFileSync(paths(root).signals, JSON.stringify({ rev: map.rev, computed: new Date().toISOString(), signals }, null, 2) + "\n");
  return signals;
}
