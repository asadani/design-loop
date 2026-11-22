import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { DesignError } from "./types.ts";
import type { HistoryEntry, Kind, MapDoc, Pins, Proposal } from "./types.ts";
import { assertValid } from "./validate.ts";

export const DIR = ".design";
const pad = (n: number) => String(n).padStart(4, "0");

export interface Paths {
  root: string; dir: string; map: string; pins: string; proposals: string; history: string; signals: string;
}
export function paths(root: string): Paths {
  const dir = join(root, DIR);
  return { root, dir, map: join(dir, "map.yaml"), pins: join(dir, "pins.yaml"), proposals: join(dir, "proposals"), history: join(dir, "history"), signals: join(dir, "signals.json") };
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
const readYaml = (file: string): unknown => parse(readFileSync(file, "utf8"));

export function initMap(root: string, kind: Kind, title: string): MapDoc {
  const p = paths(root);
  if (existsSync(p.map)) throw new DesignError("EXISTS", `${p.map} already exists`);
  mkdirSync(p.proposals, { recursive: true });
  mkdirSync(p.history, { recursive: true });
  const map: MapDoc = { version: 1, kind, title, rev: 0, nodes: [], edges: [], groups: [] };
  assertValid(map);
  const entry: HistoryEntry = { rev: 0, applied: new Date().toISOString(), proposal: null, source: { kind: "human", summary: "Initialised map" }, ops: [], decided_by: "human", snapshot: map };
  writeFileSync(join(p.history, `${pad(0)}.yaml`), stringify(entry));
  writeAtomic(p.map, stringify(map));
  writeAtomic(p.pins, stringify(emptyPins()));
  return map;
}

export const emptyPins = (): Pins => ({ pins: {}, hidden: [], locked_labels: [] });

export function loadMap(root: string): MapDoc {
  const p = paths(root);
  if (!existsSync(p.map)) throw new DesignError("NOT_FOUND", `no map at ${p.map}; run init first`);
  const m = readYaml(p.map);
  assertValid(m);
  return m;
}
export function saveMap(root: string, map: MapDoc) {
  assertValid(map);
  writeAtomic(paths(root).map, stringify(map));
}

export function loadPins(root: string): Pins {
  const p = paths(root);
  if (!existsSync(p.pins)) return emptyPins();
  const raw = (readYaml(p.pins) ?? {}) as Partial<Pins>;
  return { pins: raw.pins ?? {}, hidden: raw.hidden ?? [], locked_labels: raw.locked_labels ?? [] };
}
/** Human-only. The MCP server must never expose this. */
export function savePins(root: string, pins: Pins) {
  writeAtomic(paths(root).pins, stringify(pins));
}

function nums(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}\.yaml$/.test(f)).map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b);
}

export function listProposals(root: string): Proposal[] {
  const dir = paths(root).proposals;
  return nums(dir).map((n) => readYaml(join(dir, `${pad(n)}.yaml`)) as Proposal);
}
export function loadProposal(root: string, id: number): Proposal {
  const f = join(paths(root).proposals, `${pad(id)}.yaml`);
  if (!existsSync(f)) throw new DesignError("NOT_FOUND", `proposal ${id} does not exist`);
  return readYaml(f) as Proposal;
}
export function saveProposal(root: string, p: Proposal) {
  writeAtomic(join(paths(root).proposals, `${pad(p.id)}.yaml`), stringify(p));
}
export const nextProposalId = (root: string) => (nums(paths(root).proposals).at(-1) ?? 0) + 1;

export function listHistory(root: string): HistoryEntry[] {
  const dir = paths(root).history;
  return nums(dir).map((n) => readYaml(join(dir, `${pad(n)}.yaml`)) as HistoryEntry);
}
/** History is append-only: refuse to overwrite an existing rev. */
export function appendHistory(root: string, e: HistoryEntry) {
  const f = join(paths(root).history, `${pad(e.rev)}.yaml`);
  if (existsSync(f)) throw new DesignError("EXISTS", `history rev ${e.rev} already exists`);
  writeFileSync(f, stringify(e), { flag: "wx" });
}
