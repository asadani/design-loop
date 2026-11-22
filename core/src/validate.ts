import { EDGE_KINDS, KINDS, ROLES, STATUSES, DesignError } from "./types.ts";
import type { MapDoc } from "./types.ts";

const ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NODE_KEYS = new Set(["id", "label", "role", "status", "cites", "note"]);
const EDGE_KEYS = new Set(["id", "from", "to", "label", "kind"]);
const GROUP_KEYS = new Set(["id", "label", "members"]);
const CITE_KEYS = new Set(["path", "lines", "hash"]);

function unknownKeys(obj: object, allowed: Set<string>, where: string, errs: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) errs.push(`${where}: unknown field "${k}"`);
}

/** Returns a list of problems; empty means valid. Strict: unknown fields are errors,
 * so layout fields (x, y, at, ...) can never enter the map. */
export function validateMap(m: unknown): string[] {
  const errs: string[] = [];
  if (typeof m !== "object" || m === null) return ["map must be an object"];
  const d = m as Partial<MapDoc>;
  unknownKeys(d, new Set(["version", "kind", "title", "rev", "nodes", "edges", "groups"]), "map", errs);
  if (d.version !== 1) errs.push("version must be 1");
  if (!d.kind || !(KINDS as readonly string[]).includes(d.kind)) errs.push(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof d.title !== "string" || !d.title) errs.push("title is required");
  if (!Number.isInteger(d.rev) || (d.rev as number) < 0) errs.push("rev must be a non-negative integer");
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges) || !Array.isArray(d.groups)) {
    errs.push("nodes, edges and groups must be arrays");
    return errs;
  }
  const roles = d.kind && (KINDS as readonly string[]).includes(d.kind) ? ROLES[d.kind] : [];
  const ids = new Set<string>();
  const claim = (id: unknown, where: string) => {
    if (typeof id !== "string" || !ID.test(id)) errs.push(`${where}: id must match ${ID}`);
    else if (ids.has(id)) errs.push(`${where}: duplicate id "${id}"`);
    else ids.add(id);
  };
  const nodeIds = new Set<string>();
  for (const n of d.nodes) {
    const w = `node ${n?.id}`;
    unknownKeys(n, NODE_KEYS, w, errs);
    claim(n.id, w);
    nodeIds.add(n.id);
    if (typeof n.label !== "string" || !n.label) errs.push(`${w}: label is required`);
    if (!roles.includes(n.role)) errs.push(`${w}: role "${n.role}" not allowed for ${d.kind} (${roles.join(", ")})`);
    if (n.status !== undefined && !(STATUSES as readonly string[]).includes(n.status)) errs.push(`${w}: bad status "${n.status}"`);
    for (const c of n.cites ?? []) {
      unknownKeys(c, CITE_KEYS, `${w} cite`, errs);
      if (typeof c.path !== "string" || !c.path || c.path.startsWith("/") || c.path.split("/").includes("..")) {
        errs.push(`${w}: cite path must be relative and inside the repo`);
      }
      if (c.lines && !(c.lines.length === 2 && c.lines[0] >= 1 && c.lines[1] >= c.lines[0])) errs.push(`${w}: cite lines must be [start, end] with 1 <= start <= end`);
    }
  }
  for (const e of d.edges) {
    const w = `edge ${e?.id}`;
    unknownKeys(e, EDGE_KEYS, w, errs);
    claim(e.id, w);
    if (!nodeIds.has(e.from)) errs.push(`${w}: from "${e.from}" is not a node`);
    if (!nodeIds.has(e.to)) errs.push(`${w}: to "${e.to}" is not a node`);
    if (e.kind !== undefined && !(EDGE_KINDS as readonly string[]).includes(e.kind)) errs.push(`${w}: bad kind "${e.kind}"`);
  }
  for (const g of d.groups) {
    const w = `group ${g?.id}`;
    unknownKeys(g, GROUP_KEYS, w, errs);
    claim(g.id, w);
    if (typeof g.label !== "string" || !g.label) errs.push(`${w}: label is required`);
    for (const mem of g.members ?? []) if (!nodeIds.has(mem)) errs.push(`${w}: member "${mem}" is not a node`);
  }
  return errs;
}

export function assertValid(m: unknown): asserts m is MapDoc {
  const errs = validateMap(m);
  if (errs.length) throw new DesignError("INVALID", `invalid map: ${errs[0]}`, errs);
}
