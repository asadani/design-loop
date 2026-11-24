import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apply, baseline, computeSignals, DesignError, diffRevs, initMap, KINDS, listHistory, loadCoverage, loadMap, loadPins, loadProposal, paths, rebase, reject, saveCoverage, savePins, status, uncovered, writeSignals } from "../../core/src/index.ts";
import type { Kind, Op, Proposal } from "../../core/src/index.ts";

export interface Env {
  root: string;
  out: (s: string) => void;
  err: (s: string) => void;
  /** True only when a human is at an interactive terminal. Gates every decision command. */
  tty: boolean;
  ask: (question: string) => Promise<boolean>;
  stdin: () => Promise<string>;
}

const HELP = `design-loop <command> [--root <dir>]

Read (safe for anyone, including agents):
  status                       revision, pending proposals, drift counts
  show                         list nodes and edges
  review <id>                  what a pending proposal would change
  history                      applied changes
  diff <from> <to>             what changed between two revisions
  signals                      drift and risk signals (also refreshes signals.json)

Decide (human only: needs an interactive terminal, asks you to confirm):
  init <kind> <title>          create .design/ (kinds: ${KINDS.join(", ")})
  apply <id>                   apply a pending proposal
  reject <id> [reason]         reject a pending proposal
  rebase <id>                  move a stale proposal onto the current revision
  pin <node> <x> <y> | unpin <node>
  lock <node> | unlock <node>  forbid / allow the agent renaming a node
  coverage <exts> <root>...    watch for new code no node covers, e.g. "coverage .go internal pkg"
                               (everything uncovered today is acknowledged; only later code is flagged)
  ack <folder>...              acknowledge uncovered code you have seen and chose not to map

  view                         open the live viewer (prints a private link)

Hooks:
  hook stop                    Claude Code Stop hook: refresh signals; block once if the map has drifted
`;

const opLine = (o: Op): string => {
  switch (o.op) {
    case "add_node": return `+ node ${o.node.id} "${o.node.label}" (${o.node.role}${o.node.status ? `, ${o.node.status}` : ""})`;
    case "update_node": return `~ node ${o.id}: ${Object.entries(o.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`;
    case "remove_node": return `- node ${o.id}`;
    case "add_edge": return `+ edge ${o.edge.id} ${o.edge.from} -> ${o.edge.to}${o.edge.label ? ` "${o.edge.label}"` : ""}`;
    case "update_edge": return `~ edge ${o.id}: ${Object.entries(o.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`;
    case "remove_edge": return `- edge ${o.id}`;
    case "add_group": return `+ group ${o.group.id} "${o.group.label}" [${o.group.members.join(", ")}]`;
    case "update_group": return `~ group ${o.id}: ${Object.entries(o.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`;
    case "remove_group": return `- group ${o.id}`;
  }
};
const proposalText = (p: Proposal, rev: number) =>
  [`proposal ${p.id} [${p.state}] base rev ${p.base_rev}${p.base_rev !== rev && p.state === "pending" ? " (STALE, rebase first)" : ""}`,
   `why: ${p.source.summary}${p.source.session ? `  (session ${p.source.session}${p.source.turn !== undefined ? `, turn ${p.source.turn}` : ""})` : ""}`,
   ...p.ops.map((o) => "  " + opLine(o))].join("\n");

const num = (s: string, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new DesignError("INVALID", `${what} must be a non-negative integer, got "${s}"`);
  return n;
};

export async function run(argv: string[], env: Env): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false });
  const [cmd, ...a] = positionals;
  const { root, out } = env;
  const needHuman = async (what: string): Promise<boolean> => {
    if (!env.tty) {
      env.err(`refused: "${what}" is a human decision and needs an interactive terminal.\n`);
      return false;
    }
    if (!(await env.ask(`${what}? [y/N] `))) { out("cancelled\n"); return false; }
    return true;
  };
  try {
    switch (cmd) {
      case undefined: case "help": case "--help": out(HELP); return 0;
      case "status": {
        const s = status(root);
        const by = { high: 0, warn: 0, info: 0 };
        for (const g of computeSignals(root)) by[g.severity]++;
        out(`${s.title} (${s.kind}) rev ${s.rev}\n`);
        out(s.pending.length ? s.pending.map((p) => `  pending #${p.id}${p.stale ? " STALE" : ""}: ${p.summary}`).join("\n") + "\n" : "  no pending proposals\n");
        out(`signals: ${by.high} high, ${by.warn} warn, ${by.info} info\n`);
        return 0;
      }
      case "show": {
        const m = loadMap(root);
        out(`${m.title} (${m.kind}) rev ${m.rev}\n`);
        for (const n of m.nodes) out(`  ${n.id}  ${n.label}  [${n.role}${n.status ? `, ${n.status}` : ""}]${loadPins(root).locked_labels.includes(n.id) ? " (label locked)" : ""}\n`);
        for (const e of m.edges) out(`  ${e.from} -> ${e.to}${e.label ? `  ${e.label}` : ""}\n`);
        return 0;
      }
      case "review": {
        if (!a[0]) throw new DesignError("INVALID", "usage: review <id>");
        out(proposalText(loadProposal(root, num(a[0], "id")), loadMap(root).rev) + "\n");
        return 0;
      }
      case "history": {
        for (const e of listHistory(root)) out(`rev ${e.rev}  ${e.applied.slice(0, 19)}Z  ${e.source.summary}${e.ops.length ? `  (${e.ops.length} ops)` : ""}\n`);
        return 0;
      }
      case "diff": {
        if (a.length < 2) throw new DesignError("INVALID", "usage: diff <from> <to>");
        const d = diffRevs(root, num(a[0], "from"), num(a[1], "to"));
        if (d.empty) { out("no changes\n"); return 0; }
        for (const k of ["nodes", "edges", "groups"] as const) {
          for (const id of d[k].added) out(`+ ${k.slice(0, -1)} ${id}\n`);
          for (const id of d[k].removed) out(`- ${k.slice(0, -1)} ${id}\n`);
          for (const c of d[k].changed) out(`~ ${k.slice(0, -1)} ${c.id}: ${c.fields.join(", ")}\n`);
        }
        return 0;
      }
      case "signals": {
        const s = writeSignals(root);
        out(s.length ? s.map((g) => `${g.severity.padEnd(4)} ${g.node || g.path}  ${g.type}  ${g.detail}`).join("\n") + "\n" : "no signals\n");
        return 0;
      }
      case "init": {
        const [kind, ...t] = a;
        if (!kind || !(KINDS as readonly string[]).includes(kind) || !t.length) throw new DesignError("INVALID", `usage: init <${KINDS.join("|")}> <title>`);
        if (!(await needHuman(`create ${join(root, ".design")}`))) return 1;
        initMap(root, kind as Kind, t.join(" "));
        out("created .design/\n");
        return 0;
      }
      case "apply": {
        if (!a[0]) throw new DesignError("INVALID", "usage: apply <id>");
        const p = loadProposal(root, num(a[0], "id"));
        out(proposalText(p, loadMap(root).rev) + "\n");
        if (!(await needHuman(`apply proposal ${p.id}`))) return 1;
        const m = apply(root, p.id);
        writeSignals(root);
        out(`applied; map is now rev ${m.rev}\n`);
        return 0;
      }
      case "reject": {
        if (!a[0]) throw new DesignError("INVALID", "usage: reject <id> [reason]");
        const p = loadProposal(root, num(a[0], "id"));
        out(proposalText(p, loadMap(root).rev) + "\n");
        if (!(await needHuman(`reject proposal ${p.id}`))) return 1;
        reject(root, p.id, a.slice(1).join(" ") || undefined);
        out("rejected\n");
        return 0;
      }
      case "rebase": {
        if (!a[0]) throw new DesignError("INVALID", "usage: rebase <id>");
        if (!(await needHuman(`rebase proposal ${a[0]} onto the current revision`))) return 1;
        const p = rebase(root, num(a[0], "id"));
        out(`rebased onto rev ${p.base_rev}\n`);
        return 0;
      }
      case "pin": case "unpin": case "lock": case "unlock": {
        const id = a[0];
        if (!id) throw new DesignError("INVALID", `usage: ${cmd} <node>${cmd === "pin" ? " <x> <y>" : ""}`);
        if (!loadMap(root).nodes.some((n) => n.id === id)) throw new DesignError("NOT_FOUND", `node "${id}" does not exist`);
        const pins = loadPins(root);
        if (cmd === "pin") {
          if (a.length < 3) throw new DesignError("INVALID", "usage: pin <node> <x> <y>");
          if (!(await needHuman(`pin ${id} at ${a[1]},${a[2]}`))) return 1;
          pins.pins[id] = { x: num(a[1], "x"), y: num(a[2], "y") };
        } else if (cmd === "unpin") {
          if (!(await needHuman(`unpin ${id}`))) return 1;
          delete pins.pins[id];
        } else if (cmd === "lock") {
          if (!(await needHuman(`lock the label of ${id}`))) return 1;
          if (!pins.locked_labels.includes(id)) pins.locked_labels.push(id);
        } else {
          if (!(await needHuman(`unlock the label of ${id}`))) return 1;
          pins.locked_labels = pins.locked_labels.filter((x) => x !== id);
        }
        savePins(root, pins);
        out("ok\n");
        return 0;
      }
      case "coverage": {
        const [exts, ...roots] = a;
        if (!exts || !roots.length) throw new DesignError("INVALID", "usage: coverage <exts, comma-separated> <root>...   e.g. coverage .go internal pkg");
        const map = loadMap(root);
        const draft = { roots, extensions: exts.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`)), acknowledged: loadCoverage(root)?.acknowledged ?? [] };
        const today = uncovered(root, map, draft);
        out(`${today.length} folder group(s) under ${roots.join(", ")} are not covered by any node today:\n${today.map((u) => `  ${u.path} (${u.files} files)`).join("\n") || "  (none)"}\n`);
        if (!(await needHuman(`watch ${roots.join(", ")} for ${draft.extensions.join(", ")} and acknowledge the ${today.length} group(s) above`))) return 1;
        saveCoverage(root, { ...draft, acknowledged: baseline(root, map, draft) });
        writeSignals(root);
        out("ok: new code under these folders that no node covers will now raise an \"uncovered\" signal\n");
        return 0;
      }
      case "ack": {
        const cfg = loadCoverage(root);
        if (!cfg) throw new DesignError("NOT_FOUND", 'coverage is not enabled; run "coverage <exts> <root>..." first');
        if (!a.length) throw new DesignError("INVALID", "usage: ack <folder>...");
        const open = uncovered(root, loadMap(root), cfg).map((u) => u.path);
        const unknown = a.filter((f) => !open.includes(f.replace(/\/+$/, "")));
        if (unknown.length) throw new DesignError("NOT_FOUND", `not an open "uncovered" finding: ${unknown.join(", ")}`, open.length ? [`open: ${open.join(", ")}`] : []);
        if (!(await needHuman(`acknowledge ${a.join(", ")} as deliberately unmapped`))) return 1;
        saveCoverage(root, { ...cfg, acknowledged: [...cfg.acknowledged, ...a.map((f) => f.replace(/\/+$/, ""))] });
        writeSignals(root);
        out("ok\n");
        return 0;
      }
      case "view": {
        // Human only: the session token is shown on this terminal and nowhere else.
        if (!env.tty) { env.err('refused: "view" needs an interactive terminal (the link carries a decision token).\n'); return 1; }
        loadMap(root);
        const { startViewer } = await import("../../viewer/src/server.ts");
        const port = Number(process.env.PORT ?? 0);
        const v = await startViewer(root, (await import("node:crypto")).randomBytes(24).toString("hex"), Number.isInteger(port) ? port : 0);
        out(`design-loop viewer: ${v.url}\nCtrl-C to stop. Anyone with this link can apply or reject changes.\n`);
        await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
        await v.close();
        return 0;
      }
      case "hook": {
        if (a[0] !== "stop") throw new DesignError("INVALID", "usage: hook stop");
        return await stopHook(env);
      }
      default:
        env.err(`unknown command "${cmd}"\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof DesignError) { env.err(`${e.code}: ${e.message}\n${e.details.length ? e.details.map((d) => `  ${d}\n`).join("") : ""}`); return 1; }
    throw e;
  }
}

/**
 * Claude Code Stop hook. Refreshes signals every turn. Only blocks (once per stop) when the
 * code the map cites has demonstrably changed or vanished, so it never nags about nothing.
 */
async function stopHook(env: Env): Promise<number> {
  if (!existsSync(paths(env.root).map)) return 0; // not a design-loop repo: stay silent
  let input: { stop_hook_active?: boolean } = {};
  try { input = JSON.parse((await env.stdin()) || "{}"); } catch { /* no/invalid stdin: treat as empty */ }
  const signals = writeSignals(env.root);
  const drift = signals.filter((s) => s.type === "cite-moved" || s.type === "cite-missing" || s.type === "uncovered");
  if (!drift.length || input.stop_hook_active) return 0;
  const lines = drift.map((s) => `- ${s.node || s.path}: ${s.type} (${s.detail})`).join("\n");
  env.out(JSON.stringify({
    decision: "block",
    reason: `The design map is out of date with the code you just changed:\n${lines}\nCall map_status and map_read, then map_propose to update the affected nodes (re-cite the code, remove/rename nodes that no longer exist, or add nodes for new code that no node covers). If the map is still accurate, say so and stop.`,
  }) + "\n");
  return 0;
}
