#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { run } from "./cli.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--root");
const root = resolve(i >= 0 ? argv.splice(i, 2)[1] ?? "." : process.env.DESIGN_ROOT ?? process.cwd());

// A human is present only if BOTH stdin and stdout are terminals. An agent's shell tool has neither.
const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
const code = await run(argv, {
  root, tty,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  ask: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
  },
  stdin: async () => { let s = ""; for await (const c of process.stdin) s += c; return s; },
});
process.exit(code);
