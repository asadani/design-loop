import { layout, route, clampZoom, fitZoom, NODE_W, NODE_H } from "/layout.js";

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
// Every string from the map is agent-written, so it only ever goes in via textContent.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((x) => x != null));
  return n;
}
function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  n.append(...kids.flat().filter((x) => x != null));
  return n;
}

const params = new URLSearchParams(location.search);
let token = params.get("t") || sessionStorage.getItem("dl-token") || "";
if (token) { try { sessionStorage.setItem("dl-token", token); } catch {} }
history.replaceState(null, "", location.pathname);

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-dl-token": token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `${r.status}`);
  return j;
}
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 5000); }
const act = (path, body) => async () => { try { await api(path, body); await load(); } catch (e) { toast(e.message); } };

let state = null;
const view = { rev: null, preview: null, selected: null, zoom: 1 };   // rev: null = current
try { const z = Number(sessionStorage.getItem("dl-zoom")); if (z) view.zoom = clampZoom(z); } catch {}
let drawn = { w: 600, h: 300 };
let shown = null;                                            // { map, diff, readonly }

async function load() {
  state = await api("/api/state");
  if (view.rev !== null && view.rev > state.map.rev) view.rev = null;
  if (view.preview !== null && !state.proposals.some((p) => p.id === view.preview && p.state === "pending")) view.preview = null;
  shown = { map: state.map, diff: null, readonly: false, ghosts: null };
  try {
    if (view.preview !== null) { const r = await api(`/api/preview?id=${view.preview}`); shown = { map: r.map, diff: r.diff, readonly: true, ghosts: state.map }; }
    else if (view.rev !== null) { const r = await api(`/api/rev?n=${view.rev}`); shown = { map: r.map, diff: r.diff, readonly: true, ghosts: view.rev > 0 ? await api(`/api/rev?n=${view.rev - 1}`).then((x) => x.map) : null }; }
    else if (state.map.rev > 0) { const r = await api(`/api/rev?n=${state.map.rev}`); shown.latest = r.diff; }
  } catch (e) { toast(e.message); view.preview = null; view.rev = null; shown = { map: state.map, diff: null, readonly: false, ghosts: null }; }
  render();
}

const when = (iso) => iso.replace("T", " ").slice(0, 16);
const opLine = (o) => {
  const set = (x) => Object.entries(x).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  switch (o.op) {
    case "add_node": return `+ ${o.node.id} “${o.node.label}” (${o.node.role})`;
    case "update_node": return `~ ${o.id}: ${set(o.set)}`;
    case "remove_node": return `− ${o.id}`;
    case "add_edge": return `+ ${o.edge.from} → ${o.edge.to}`;
    case "update_edge": return `~ edge ${o.id}: ${set(o.set)}`;
    case "remove_edge": return `− edge ${o.id}`;
    case "add_group": return `+ group ${o.group.id}`;
    case "update_group": return `~ group ${o.id}: ${set(o.set)}`;
    default: return `− group ${o.id}`;
  }
};

function render() {
  const { map } = state;
  $("title").textContent = map.title;
  $("meta").textContent = `${map.kind} · rev ${map.rev}`;
  renderBanner(); renderTimeline(); renderCanvas(); renderSide();
}

function renderBanner() {
  const b = $("banner");
  if (view.preview === null && view.rev === null) { b.hidden = true; return; }
  b.hidden = false; b.replaceChildren(
    el("span", { text: view.preview !== null ? `Previewing proposal ${view.preview}: not applied.` : `Viewing rev ${view.rev}: read-only.` }),
    el("button", { text: "Back to current", onclick: () => { view.preview = null; view.rev = null; load(); } }));
}

function renderTimeline() {
  const t = $("timeline");
  t.replaceChildren(el("h2", { text: "What happened" }),
    ...[...state.history].reverse().map((e) => el("button", { class: "rev" + ((view.rev ?? state.map.rev) === e.rev && view.preview === null ? " sel" : ""), onclick: () => { view.preview = null; view.rev = e.rev === state.map.rev ? null : e.rev; load(); } },
      el("b", { text: `rev ${e.rev}` }), el("small", { text: when(e.applied) }), el("span", { text: e.source.summary }))));
}

function renderSide() {
  const side = $("side");
  const pend = state.proposals.filter((p) => p.state === "pending");
  const kids = [el("h2", { text: `Waiting for you (${pend.length})` })];
  if (!pend.length) kids.push(el("p", { class: "empty", text: "Nothing pending." }));
  for (const p of pend) {
    kids.push(el("div", { class: "card" + (p.stale ? " stale" : "") },
      el("b", { class: "mono", text: `#${p.id} · base rev ${p.base_rev}${p.stale ? " · STALE" : ""}` }),
      el("p", { text: p.source.summary }),
      el("ul", { class: "ops" }, ...p.ops.map((o) => el("li", { text: opLine(o) }))),
      el("div", { class: "row" },
        el("button", { text: view.preview === p.id ? "Hide preview" : "Preview", onclick: () => { view.rev = null; view.preview = view.preview === p.id ? null : p.id; load(); } }),
        p.stale ? el("button", { text: "Rebase", onclick: act("/api/rebase", { id: p.id }) }) : el("button", { class: "primary", text: "Apply", onclick: act("/api/apply", { id: p.id }) }),
        el("button", { text: "Reject", onclick: act("/api/reject", { id: p.id }) }))));
  }
  kids.push(el("h2", { text: `Where it might go wrong (${state.signals.length})` }));
  if (!state.signals.length) kids.push(el("p", { class: "empty", text: "No drift detected." }));
  for (const g of state.signals) kids.push(el("div", { class: "sig", onclick: () => { view.selected = g.node; render(); } }, el("span", { class: `sev ${g.severity}`, text: g.severity }), el("span", {}, el("b", { text: g.node }), ` ${g.type}: ${g.detail}`)));
  const sel = view.selected && shown.map.nodes.find((n) => n.id === view.selected);
  if (sel) {
    const locked = state.pins.locked_labels.includes(sel.id), pinned = !!state.pins.pins[sel.id];
    const touched = state.history.filter((e) => e.ops.some((o) => o.id === sel.id || o.node?.id === sel.id));
    kids.push(el("h2", { text: "Selected" }), el("div", { class: "card" },
      el("b", { text: sel.label }), el("div", { class: "mono", text: `${sel.id} · ${sel.role}${sel.status ? " · " + sel.status : ""}` }),
      sel.note ? el("p", { text: sel.note }) : null,
      ...(sel.cites ?? []).map((c) => el("div", { class: "mono", text: `${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}` })),
      touched.length ? el("p", { class: "mono", text: "touched in rev " + touched.map((e) => e.rev).join(", ") }) : null,
      shown.readonly ? null : el("div", { class: "row" },
        el("button", { text: locked ? "Unlock label" : "Lock label", onclick: act(locked ? "/api/unlock" : "/api/lock", { id: sel.id }) }),
        pinned ? el("button", { text: "Unpin position", onclick: act("/api/unpin", { id: sel.id }) }) : null)));
  }
  side.replaceChildren(...kids);
}

function renderCanvas() {
  const svg = $("canvas");
  const cur = shown.map, ghosts = shown.ghosts;
  const added = new Set(shown.diff ? [...shown.diff.nodes.added] : []), changed = new Set(shown.diff ? shown.diff.nodes.changed.map((c) => c.id) : []);
  const removed = new Set(shown.diff ? shown.diff.nodes.removed : []);
  const addedE = new Set(shown.diff?.edges.added ?? []), removedE = new Set(shown.diff?.edges.removed ?? []);
  // "new" = changed in the latest applied revision (only when looking at the live map; previews use the accent colour)
  // If the latest rev added every node (e.g. the first import), "new" says nothing, so skip it.
  const L0 = shown.diff ? null : shown.latest;
  const L = L0 && !(L0.nodes.added.length >= cur.nodes.length && cur.nodes.length > 0) ? L0 : null;
  const newN = new Set(L ? [...L.nodes.added, ...L.nodes.changed.map((c) => c.id)] : []);
  const newE = new Set(L ? [...L.edges.added, ...L.edges.changed.map((c) => c.id)] : []);
  const nodes = [...cur.nodes, ...(ghosts ? ghosts.nodes.filter((n) => removed.has(n.id)) : [])];
  const edges = [...cur.edges, ...(ghosts ? ghosts.edges.filter((e) => removedE.has(e.id)) : [])];
  const { pos, width, height } = layout(nodes, edges, state.pins.pins);
  drawn = { w: Math.max(width, 600), h: Math.max(height, 300) };
  svg.setAttribute("viewBox", `0 0 ${drawn.w} ${drawn.h}`);
  applyZoom();
  svg.classList.toggle("readonly", shown.readonly);
  const sev = {}; for (const g of state.signals) if (!sev[g.node] || g.severity === "high") sev[g.node] = g.severity;

  const defs = s("defs", {}, s("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, s("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--muted)" })));
  const groups = cur.groups.map((g) => {
    const ps = g.members.map((m) => pos[m]).filter(Boolean); if (!ps.length) return null;
    const x = Math.min(...ps.map((p) => p.x)) - 14, y = Math.min(...ps.map((p) => p.y)) - 26;
    return s("g", {}, s("rect", { class: "group", x, y, width: Math.max(...ps.map((p) => p.x)) + NODE_W + 14 - x, height: Math.max(...ps.map((p) => p.y)) + NODE_H + 14 - y, rx: 4 }), s("text", { class: "group-label", x: x + 8, y: y + 15, text: g.label }));
  });
  const edgeEls = edges.filter((e) => pos[e.from] && pos[e.to]).map((e) => {
    const r = route(pos[e.from], pos[e.to]);
    return s("g", {}, s("path", { class: "edge" + (addedE.has(e.id) ? " added" : removedE.has(e.id) ? " removed" : newE.has(e.id) ? " new" : ""), d: r.d, "marker-end": "url(#arrow)" }), e.label ? s("text", { class: "edge-label", x: r.lx, y: r.ly, "text-anchor": r.anchor, text: e.label }) : null);
  });
  const nodeEls = nodes.map((n) => {
    const p = pos[n.id], diffTag = added.has(n.id) ? "+" : changed.has(n.id) ? "~" : removed.has(n.id) ? "−" : "";
    const g = s("g", { class: ["node", n.status ?? "", added.has(n.id) ? "added" : changed.has(n.id) ? "changed" : removed.has(n.id) ? "removed" : newN.has(n.id) ? "new" : "", view.selected === n.id ? "sel" : ""].filter(Boolean).join(" "), transform: `translate(${p.x},${p.y})`, tabindex: "0", role: "button", "aria-label": `${n.label}, ${n.role}` },
      s("rect", { class: "box", width: NODE_W, height: NODE_H, rx: 4 }),
      s("text", { class: "role", x: 10, y: 17, text: n.role + (n.status ? " · " + n.status : "") }),
      s("text", { class: "label", x: 10, y: 40, text: n.label.length > 24 ? n.label.slice(0, 23) + "…" : n.label }),
      s("text", { class: "tag", x: 10, y: 57, text: [state.pins.locked_labels.includes(n.id) ? "label locked" : "", p.pinned ? "pinned" : ""].filter(Boolean).join(" · ") }),
      diffTag ? s("text", { class: "tag diff", x: NODE_W - 16, y: 17, text: diffTag }) : null,
      newN.has(n.id) ? s("text", { class: "tag fresh", x: NODE_W - 32, y: 17, text: "new" }) : null,
      sev[n.id] ? s("g", { class: "badge " + sev[n.id], transform: `translate(${NODE_W},0)` }, s("circle", { r: 9 }), s("text", { y: 3.5, text: "!" })) : null);
    g.addEventListener("click", () => { view.selected = n.id; renderSide(); renderCanvas(); });
    if (!shown.readonly && !removed.has(n.id)) enableDrag(g, svg, n.id, p);
    return g;
  });
  svg.replaceChildren(defs, ...groups, ...edgeEls, ...nodeEls);
  renderLegend(L, newN.size + newE.size);
}

function renderLegend(L, newCount) {
  const k = (cls, text) => el("span", {}, el("i", { class: cls }), text);
  const items = [];
  if (shown.diff) items.push(k("k-pending", view.preview !== null ? "+ added  ~ changed  − removed (preview)" : "+ added  ~ changed  − removed in this rev"));
  else if (newCount) items.push(k("k-new", `new in rev ${state.map.rev}`));
  items.push(k("k-planned", "planned"));
  $("legend").replaceChildren(...items);
}

// ---- zoom and pan. The map is shown at natural size and scrolls; it is never shrunk to fit unless asked.
function applyZoom() {
  const svg = $("canvas");
  svg.setAttribute("width", String(Math.round(drawn.w * view.zoom)));
  svg.setAttribute("height", String(Math.round(drawn.h * view.zoom)));
  $("z-reset").textContent = `${Math.round(view.zoom * 100)}%`;
}
function setZoom(z, cx, cy) {
  const sc = $("scroller"), old = view.zoom, next = clampZoom(z);
  if (next === old) return;
  const px = (sc.scrollLeft + cx) / old, py = (sc.scrollTop + cy) / old;   // content point under the cursor
  view.zoom = next; try { sessionStorage.setItem("dl-zoom", String(next)); } catch {}
  applyZoom();
  sc.scrollLeft = px * next - cx; sc.scrollTop = py * next - cy;
}
(function wireView() {
  const sc = $("scroller");
  const mid = () => [sc.clientWidth / 2, sc.clientHeight / 2];
  $("z-in").addEventListener("click", () => setZoom(view.zoom * 1.25, ...mid()));
  $("z-out").addEventListener("click", () => setZoom(view.zoom / 1.25, ...mid()));
  $("z-reset").addEventListener("click", () => setZoom(1, ...mid()));
  $("z-fit").addEventListener("click", () => setZoom(fitZoom(drawn.w, drawn.h, sc.clientWidth - 24, sc.clientHeight - 24), ...mid()));
  sc.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;               // plain scroll stays native scrolling
    e.preventDefault();
    const r = sc.getBoundingClientRect();
    setZoom(view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // drag the background to pan (nodes keep their own drag-to-pin)
  sc.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".node")) return;
    const x0 = e.clientX, y0 = e.clientY, l0 = sc.scrollLeft, t0 = sc.scrollTop;
    sc.classList.add("panning"); sc.setPointerCapture(e.pointerId);
    const mv = (m) => { sc.scrollLeft = l0 - (m.clientX - x0); sc.scrollTop = t0 - (m.clientY - y0); };
    const up = () => { sc.classList.remove("panning"); sc.removeEventListener("pointermove", mv); sc.removeEventListener("pointerup", up); };
    sc.addEventListener("pointermove", mv); sc.addEventListener("pointerup", up);
  });
})();

// Drag a node; releasing it pins the position (the human channel the agent can never write).
function enableDrag(g, svg, id, start) {
  g.addEventListener("pointerdown", (ev) => {
    const m = svg.getScreenCTM(); if (!m) return;
    const ox = ev.clientX, oy = ev.clientY; let moved = false, x = start.x, y = start.y;
    g.setPointerCapture(ev.pointerId); g.classList.add("dragging");
    const mv = (e) => { moved = true; x = Math.max(0, start.x + (e.clientX - ox) / m.a); y = Math.max(0, start.y + (e.clientY - oy) / m.d); g.setAttribute("transform", `translate(${x},${y})`); };
    const up = async () => {
      g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); g.classList.remove("dragging");
      if (moved && Math.hypot(x - start.x, y - start.y) > 3) { try { await api("/api/pin", { id, x, y }); } catch (e) { toast(e.message); } await load(); }
    };
    g.addEventListener("pointermove", mv); g.addEventListener("pointerup", up);
  });
}

function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.onopen = () => { $("live").textContent = "live"; $("live").className = "mono on"; };
  es.onerror = () => { $("live").textContent = "reconnecting…"; $("live").className = "mono"; };
  es.addEventListener("changed", () => load().catch((e) => toast(e.message)));
}
if (!token) { $("title").textContent = "Open the link printed by `design-loop view`."; }
else load().then(connect).catch((e) => { $("title").textContent = "Cannot load"; toast(e.message); });
