import { DesignError } from "./types.ts";
import type { MapDoc, Op, Pins } from "./types.ts";
import { assertValid } from "./validate.ts";

const NODE_SET = new Set(["label", "role", "status", "cites", "note"]);
const EDGE_SET = new Set(["from", "to", "label", "kind"]);
const GROUP_SET = new Set(["label", "members"]);

function checkSet(set: object, allowed: Set<string>, what: string) {
  for (const k of Object.keys(set)) {
    if (!allowed.has(k)) throw new DesignError("INVALID", `${what}: cannot set "${k}"`, [k]);
  }
}
function find<T extends { id: string }>(list: T[], id: string, what: string): T {
  const x = list.find((i) => i.id === id);
  if (!x) throw new DesignError("NOT_FOUND", `${what} "${id}" does not exist`);
  return x;
}

/** Pure: returns a new map with ops applied, or throws. Does not touch rev. */
export function applyOps(map: MapDoc, ops: Op[], pins?: Pins): MapDoc {
  const next = structuredClone(map);
  const locked = new Set(pins?.locked_labels ?? []);
  for (const op of ops) {
    switch (op.op) {
      case "add_node": next.nodes.push(structuredClone(op.node)); break;
      case "update_node": {
        checkSet(op.set, NODE_SET, `update_node ${op.id}`);
        const n = find(next.nodes, op.id, "node");
        if ("label" in op.set && locked.has(op.id) && op.set.label !== n.label) {
          throw new DesignError("PIN_VIOLATION", `label of "${op.id}" is locked by a human`, [op.id]);
        }
        Object.assign(n, structuredClone(op.set));
        break;
      }
      case "remove_node": {
        find(next.nodes, op.id, "node");
        const used = next.edges.filter((e) => e.from === op.id || e.to === op.id).map((e) => e.id);
        const grouped = next.groups.filter((g) => g.members.includes(op.id)).map((g) => g.id);
        if (used.length || grouped.length) {
          throw new DesignError("INVALID", `cannot remove node "${op.id}": remove its edges/group membership first`, [...used, ...grouped]);
        }
        next.nodes = next.nodes.filter((n) => n.id !== op.id);
        break;
      }
      case "add_edge": next.edges.push(structuredClone(op.edge)); break;
      case "update_edge": {
        checkSet(op.set, EDGE_SET, `update_edge ${op.id}`);
        Object.assign(find(next.edges, op.id, "edge"), structuredClone(op.set));
        break;
      }
      case "remove_edge": find(next.edges, op.id, "edge"); next.edges = next.edges.filter((e) => e.id !== op.id); break;
      case "add_group": next.groups.push(structuredClone(op.group)); break;
      case "update_group": {
        checkSet(op.set, GROUP_SET, `update_group ${op.id}`);
        Object.assign(find(next.groups, op.id, "group"), structuredClone(op.set));
        break;
      }
      case "remove_group": find(next.groups, op.id, "group"); next.groups = next.groups.filter((g) => g.id !== op.id); break;
      default: throw new DesignError("INVALID", `unknown op "${(op as { op: string }).op}"`);
    }
  }
  assertValid(next);
  return next;
}
