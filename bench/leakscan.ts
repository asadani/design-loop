import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadGolden } from "./score.ts";

/**
 * Finds text files left in a stripped repo that still describe the architecture: files that
 * mention several golden components. Code is ignored (it is the thing under test); prose is not.
 */
const TEXT = /\.(md|mdx|txt|rst|adoc|1|yml|yaml|dot|gv|puml|plantuml|mmd|mermaid|drawio|excalidraw|svg)$/i;
export function leakScan(goldenFile: string, repoRoot: string, min = 4): { file: string; hits: string[] }[] {
  const g = loadGolden(goldenFile);
  const terms = g.nodes.flatMap((n) => [...(n.paths ?? []).map((p) => p.replace(/\.php$/, "")), ...(n.citable === false ? [] : [n.label.replace(/\s*\(.*\)/, "")])]).filter((t) => t.length > 3);
  const out: { file: string; hits: string[] }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(repoRoot, rel))) {
      if (name === "node_modules" || name === ".git") continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(repoRoot, r));
      if (st.isDirectory()) walk(r);
      else if (TEXT.test(name) && st.size < 400_000) {
        const body = readFileSync(join(repoRoot, r), "utf8").toLowerCase();
        const hits = [...new Set(terms.filter((t) => body.includes(t.toLowerCase())))];
        if (hits.length >= min) out.push({ file: r, hits });
      }
    }
  };
  walk("");
  return out.sort((a, b) => b.hits.length - a.hits.length);
}
if (import.meta.main) {
  const [golden, root, min] = process.argv.slice(2);
  if (!golden || !root) { console.error("usage: leakscan.ts <golden.yaml> <stripped repo root> [min-hits]"); process.exit(2); }
  const r = leakScan(golden, root, min ? Number(min) : 4);
  console.log(r.length ? r.map((x) => `${String(x.hits.length).padStart(3)}  ${x.file}\n       ${x.hits.slice(0, 6).join(", ")}`).join("\n") : "no leaks found");
}
