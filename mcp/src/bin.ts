#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createServer } from "./server.ts";

// Repo root: first CLI arg, then $DESIGN_ROOT, then the working directory.
const root = resolve(process.argv[2] ?? process.env.DESIGN_ROOT ?? process.cwd());
if (!existsSync(resolve(root, ".design/map.yaml"))) {
  console.error(`design-loop: no .design/map.yaml in ${root}. Initialise one first.`);
  process.exit(1);
}
await createServer(root).connect(new StdioServerTransport());
