import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync, watch } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, applyOps, computeSignals, DesignError, diffMaps, diffRevs, listHistory, listProposals, loadMap, loadPins, mapAtRev, paths, rebase, reject, savePins, loadProposal } from "../../core/src/index.ts";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/layout.js": ["layout.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > 64_000) throw new DesignError("INVALID", "body too large"); chunks.push(c as Buffer); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString() || "{}"); return typeof v === "object" && v ? v : {}; } catch { throw new DesignError("INVALID", "body is not valid JSON"); }
}
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new DesignError("INVALID", `${what} must be a non-negative integer`);
  return v;
};

/**
 * Human-facing viewer. Decisions (apply/reject/pin/lock) are only accepted with the
 * per-session token, which is printed to the human's terminal and never written to disk.
 * Binds to loopback only and rejects foreign Host/Origin headers (DNS rebinding, CSRF).
 */
export function createViewer(root: string, token: string): { server: Server; allowedHosts: Set<string> } {
  const allowedHosts = new Set<string>();
  const clients = new Set<ServerResponse>();

  const state = () => {
    const map = loadMap(root);
    return {
      map, pins: loadPins(root), signals: computeSignals(root, map),
      proposals: listProposals(root).map((p) => ({ ...p, stale: p.state === "pending" && p.base_rev !== map.rev })),
      history: listHistory(root).map((e) => ({ rev: e.rev, applied: e.applied, proposal: e.proposal, source: e.source, ops: e.ops })),
    };
  };

  // Push a "changed" ping to open pages whenever .design/ changes on disk.
  let timer: NodeJS.Timeout | undefined;
  const watcher = existsSync(paths(root).dir) ? watch(paths(root).dir, { recursive: true }, (_e, f) => {
    if (f && f.endsWith(".tmp")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { for (const c of clients) c.write("event: changed\ndata: {}\n\n"); }, 80);
  }) : null;

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (!allowedHosts.has(req.headers.host ?? "")) return send(403, { code: "FORBIDDEN", message: "bad host" });
      const stat = STATIC[url.pathname];
      if (req.method === "GET" && stat) return send(200, readFileSync(join(PUBLIC, stat[0])), stat[1]);
      if (!url.pathname.startsWith("/api/")) return send(404, { code: "NOT_FOUND", message: "not found" });

      const given = String(req.headers["x-dl-token"] ?? url.searchParams.get("t") ?? "");
      if (!safeEq(given, token)) return send(401, { code: "UNAUTHORIZED", message: "missing or wrong token" });

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "content-security-policy": CSP });
        res.write("retry: 1000\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, state());
      if (req.method === "GET" && url.pathname === "/api/rev") {
        const n = int(Number(url.searchParams.get("n")), "n");
        return send(200, { map: mapAtRev(root, n), diff: n > 0 ? diffRevs(root, n - 1, n) : null });
      }
      if (req.method === "GET" && url.pathname === "/api/preview") {
        const p = loadProposal(root, int(Number(url.searchParams.get("id")), "id"));
        const cur = loadMap(root);
        const next = applyOps(cur, p.ops, loadPins(root));
        return send(200, { map: next, diff: diffMaps(cur, next) });
      }

      if (req.method !== "POST") return send(405, { code: "INVALID", message: "method not allowed" });
      const origin = req.headers.origin;
      if (origin && ![...allowedHosts].some((h) => origin === `http://${h}`)) return send(403, { code: "FORBIDDEN", message: "bad origin" });
      const b = await readJson(req);
      const node = (): string => {
        if (typeof b.id !== "string" || !loadMap(root).nodes.some((n) => n.id === b.id)) throw new DesignError("NOT_FOUND", "no such node");
        return b.id;
      };
      switch (url.pathname) {
        case "/api/apply": apply(root, int(b.id, "id")); break;
        case "/api/reject": reject(root, int(b.id, "id"), typeof b.reason === "string" && b.reason ? b.reason : undefined); break;
        case "/api/rebase": rebase(root, int(b.id, "id")); break;
        case "/api/pin": {
          const id = node(); const pins = loadPins(root);
          if (typeof b.x !== "number" || typeof b.y !== "number" || !Number.isFinite(b.x) || !Number.isFinite(b.y)) throw new DesignError("INVALID", "x and y must be numbers");
          pins.pins[id] = { x: Math.round(b.x), y: Math.round(b.y) }; savePins(root, pins); break;
        }
        case "/api/unpin": { const id = node(); const pins = loadPins(root); delete pins.pins[id]; savePins(root, pins); break; }
        case "/api/lock": { const id = node(); const pins = loadPins(root); if (!pins.locked_labels.includes(id)) pins.locked_labels.push(id); savePins(root, pins); break; }
        case "/api/unlock": { const id = node(); const pins = loadPins(root); pins.locked_labels = pins.locked_labels.filter((x) => x !== id); savePins(root, pins); break; }
        default: return send(404, { code: "NOT_FOUND", message: "not found" });
      }
      return send(200, { ok: true });
    } catch (e) {
      if (e instanceof DesignError) return send(e.code === "NOT_FOUND" ? 404 : e.code === "STALE" || e.code === "NOT_PENDING" ? 409 : e.code === "PIN_VIOLATION" ? 409 : 400, { code: e.code, message: e.message, details: e.details });
      console.error(e);
      return send(500, { code: "INTERNAL", message: "internal error" });
    }
  });
  server.on("close", () => { watcher?.close(); clearTimeout(timer); for (const c of clients) c.end(); });
  return { server, allowedHosts };
}

export async function startViewer(root: string, token: string, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const { server, allowedHosts } = createViewer(root, token);
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(port, "127.0.0.1", ok); });
  const p = (server.address() as { port: number }).port;
  allowedHosts.add(`127.0.0.1:${p}`); allowedHosts.add(`localhost:${p}`);
  return { url: `http://127.0.0.1:${p}/?t=${token}`, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}
