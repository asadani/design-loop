import type { MapDoc } from "./types.ts";

export interface Changed { id: string; fields: string[] }
export interface Section { added: string[]; removed: string[]; changed: Changed[] }
export interface MapDiff { nodes: Section; edges: Section; groups: Section; empty: boolean }

function section<T extends { id: string }>(a: T[], b: T[]): Section {
  const am = new Map(a.map((x) => [x.id, x]));
  const bm = new Map(b.map((x) => [x.id, x]));
  const out: Section = { added: [], removed: [], changed: [] };
  for (const id of bm.keys()) if (!am.has(id)) out.added.push(id);
  for (const id of am.keys()) if (!bm.has(id)) out.removed.push(id);
  for (const [id, x] of am) {
    const y = bm.get(id);
    if (!y) continue;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    const fields = [...keys].filter((k) => JSON.stringify((x as Record<string, unknown>)[k]) !== JSON.stringify((y as Record<string, unknown>)[k]));
    if (fields.length) out.changed.push({ id, fields });
  }
  return out;
}

export function diffMaps(a: MapDoc, b: MapDoc): MapDiff {
  const nodes = section(a.nodes, b.nodes), edges = section(a.edges, b.edges), groups = section(a.groups, b.groups);
  const empty = [nodes, edges, groups].every((s) => !s.added.length && !s.removed.length && !s.changed.length);
  return { nodes, edges, groups, empty };
}
