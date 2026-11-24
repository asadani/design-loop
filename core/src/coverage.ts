import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { DesignError } from "./types.ts";
import type { MapDoc } from "./types.ts";
import { SKIP_DIR, SKIP_FILE } from "./flow.ts";
import { paths } from "./store.ts";

/**
 * Coverage: code that no node cites. Cite signals only watch code the map already points at, so a brand-new
 * component is invisible to them. This finds source folders under the configured roots that no cite covers.
 *
 * Human-only config (.design/coverage.yaml), like pins: the MCP server never writes it. `acknowledged` is the
 * baseline: folders a human has seen and chosen not to map. Enabling coverage acknowledges everything uncovered
 * at that moment, so only code that appears LATER raises a signal.
 */
export interface CoverageConfig {
  /** Folders to watch, relative to the repo root (e.g. internal, pkg, src). */
  roots: string[];
  /** File extensions that count as source (e.g. .go, .ts). */
  extensions: string[];
  /** Folders a human has seen and decided not to map. Anything inside them is ignored. */
  acknowledged: string[];
}

export interface Uncovered { path: string; folders: number; files: number }

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
const coverageFile = (root: string) => join(paths(root).dir, "coverage.yaml");

export function loadCoverage(root: string): CoverageConfig | null {
  const f = coverageFile(root);
  if (!existsSync(f)) return null;
  const raw = (parse(readFileSync(f, "utf8")) ?? {}) as Partial<CoverageConfig>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  return { roots: list(raw.roots).map(norm), extensions: list(raw.extensions), acknowledged: list(raw.acknowledged).map(norm) };
}

/** Human-only. The MCP server must never expose this. */
export function saveCoverage(root: string, cfg: CoverageConfig) {
  if (!cfg.roots.length || !cfg.extensions.length) throw new DesignError("INVALID", "coverage needs at least one root and one extension");
  for (const r of cfg.roots) if (r.startsWith("/") || r.split("/").includes("..")) throw new DesignError("INVALID", `root must be inside the repo: ${r}`);
  const f = coverageFile(root);
  writeFileSync(`${f}.tmp`, stringify({ ...cfg, acknowledged: [...new Set(cfg.acknowledged)].sort() }));
  renameSync(`${f}.tmp`, f);
}

/** Source folders (folders that directly hold at least one source file) under the roots, with their file counts. */
function sourceFolders(root: string, cfg: CoverageConfig): Map<string, number> {
  const out = new Map<string, number>();
  const isSrc = (name: string) => !SKIP_FILE.test(name) && cfg.extensions.some((e) => name.endsWith(e));
  const walk = (rel: string) => {
    let files = 0;
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(rel === "." ? e.name : `${rel}/${e.name}`); }   // root "." must yield "c", not "./c"
      else if (e.isFile() && isSrc(e.name)) files++;
    }
    if (files) out.set(rel, files);
  };
  for (const r of cfg.roots.map(norm)) {
    const abs = join(root, r);
    if (existsSync(abs) && !lstatSync(abs).isSymbolicLink() && lstatSync(abs).isDirectory()) walk(r);
  }
  return out;
}

/**
 * Uncovered source, grouped: a folder and its uncovered sub-folders are one finding (a new component with
 * sub-packages is one thing to map, not five). A folder is covered when a cite points at it or above it, or at a
 * file directly inside it.
 */
export function uncovered(root: string, map: MapDoc, cfg: CoverageConfig): Uncovered[] {
  const cites = map.nodes.flatMap((n) => (n.cites ?? []).map((c) => norm(c.path)));
  const covered = (dir: string) => cites.some((c) => under(dir, c) || dirname(c) === dir);
  const acks = cfg.acknowledged.map(norm);
  const acked = (dir: string) => acks.some((a) => under(dir, a));
  const loose = [...sourceFolders(root, cfg)].filter(([d]) => !covered(d) && !acked(d)).sort(([a], [b]) => a.localeCompare(b));
  const units: Uncovered[] = [];
  for (const [dir, files] of loose) {
    const u = units.find((x) => under(dir, x.path));
    if (u) { u.folders++; u.files += files; } else units.push({ path: dir, folders: 1, files });
  }
  return units;
}

/** The value of `acknowledged` that makes everything uncovered right now part of the baseline. */
export function baseline(root: string, map: MapDoc, cfg: CoverageConfig): string[] {
  return [...cfg.acknowledged, ...uncovered(root, map, cfg).map((u) => u.path)];
}
