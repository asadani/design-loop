// Pure layout: no DOM. Auto-layout places nodes in columns by dependency depth; human pins win.
export const NODE_W = 190, NODE_H = 64, COL_GAP = 170, ROW_GAP = 56, PAD = 48;

/** @param nodes {id}[]  @param edges {from,to}[]  @param pins {[id]:{x,y}} */
export function layout(nodes, edges, pins = {}) {
  const ids = nodes.map((n) => n.id);
  const rank = Object.fromEntries(ids.map((i) => [i, 0]));
  // Longest-path ranking. Capped passes, so cycles settle instead of looping forever.
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (e.from === e.to || !(e.from in rank) || !(e.to in rank)) continue;
      if (rank[e.to] < rank[e.from] + 1 && rank[e.from] + 1 < ids.length) { rank[e.to] = rank[e.from] + 1; moved = true; }
    }
    if (!moved) break;
  }
  const cols = new Map();
  for (const id of ids) { const r = rank[id]; (cols.get(r) ?? cols.set(r, []).get(r)).push(id); }
  const pos = {};
  const rows = {};
  for (const r of [...cols.keys()].sort((a, b) => a - b)) {
    const col = cols.get(r);
    // order by the average row of already-placed parents, to reduce crossings
    const score = (id) => {
      const ps = edges.filter((e) => e.to === id && e.from in rows).map((e) => rows[e.from]);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
    };
    col.sort((a, b) => score(a) - score(b) || ids.indexOf(a) - ids.indexOf(b));
    col.forEach((id, i) => { rows[id] = i; pos[id] = { x: PAD + r * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP), pinned: false }; });
  }
  for (const id of ids) if (pins[id]) pos[id] = { x: pins[id].x, y: pins[id].y, pinned: true };
  let w = 0, h = 0;
  for (const id of ids) { w = Math.max(w, pos[id].x + NODE_W); h = Math.max(h, pos[id].y + NODE_H); }
  return { pos, width: w + PAD, height: h + PAD };
}

/** Orthogonal connector with rounded corners, source -> target. Returns {d, lx, ly}. */
export function route(a, b) {
  const R = 8;
  const right = b.x >= a.x + NODE_W + 2;
  if (right) {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    if (Math.abs(y1 - y2) < 1) return { d: `M${x1},${y1} H${x2}`, lx: (x1 + x2) / 2, ly: y1 - 6, anchor: "middle" };
    const mid = (x1 + x2) / 2, s = y2 > y1 ? 1 : -1;
    return { d: `M${x1},${y1} H${mid - R} Q${mid},${y1} ${mid},${y1 + s * R} V${y2 - s * R} Q${mid},${y2} ${mid + R},${y2} H${x2}`, lx: mid + 6, ly: (y1 + y2) / 2, anchor: "start" };
  }
  // same column or backwards: leave the bottom/top edge and come back around
  const down = b.y >= a.y;
  const x1 = a.x + NODE_W / 2, y1 = down ? a.y + NODE_H : a.y, x2 = b.x + NODE_W / 2, y2 = down ? b.y : b.y + NODE_H;
  const mid = (y1 + y2) / 2;
  return { d: `M${x1},${y1} V${mid} H${x2} V${y2}`, lx: (x1 + x2) / 2 + 6, ly: mid - 4, anchor: "start" };
}

export const ZOOM_MIN = 0.25, ZOOM_MAX = 3;
export const clampZoom = (z) => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1);
/** Zoom that makes a w x h drawing fit a box, never enlarging past 100% so small maps stay crisp. */
export function fitZoom(w, h, boxW, boxH) {
  if (!(w > 0) || !(h > 0) || !(boxW > 0) || !(boxH > 0)) return 1;
  return clampZoom(Math.min(1, boxW / w, boxH / h));
}
