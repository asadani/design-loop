export const KINDS = ["architecture", "sequence", "state", "dataflow", "flowchart", "dependency"] as const;
export type Kind = (typeof KINDS)[number];

/** Closed role vocabulary per diagram kind. Roles drive style, never layout. */
export const ROLES: Record<Kind, readonly string[]> = {
  architecture: ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"],
  sequence: ["actor", "service", "store", "external"],
  state: ["initial", "state", "final", "choice"],
  dataflow: ["source", "process", "store", "sink"],
  flowchart: ["start", "process", "decision", "io", "end"],
  dependency: ["module", "package", "external"],
};

export const STATUSES = ["planned", "in-progress", "stable", "deprecated"] as const;
export type Status = (typeof STATUSES)[number];
export const EDGE_KINDS = ["sync", "async", "data", "control"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Cite {
  path: string;
  lines?: [number, number];
  /** sha256 of the cited lines (or whole file). Filled in when a change is applied. */
  hash?: string;
}
export interface MapNode {
  id: string;
  label: string;
  role: string;
  status?: Status;
  cites?: Cite[];
  note?: string;
}
export interface MapEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
}
export interface MapGroup {
  id: string;
  label: string;
  members: string[];
}
export interface MapDoc {
  version: 1;
  kind: Kind;
  title: string;
  rev: number;
  nodes: MapNode[];
  edges: MapEdge[];
  groups: MapGroup[];
}

export interface Pins {
  pins: Record<string, { x: number; y: number }>;
  hidden: string[];
  locked_labels: string[];
}

export type Op =
  | { op: "add_node"; node: MapNode }
  | { op: "update_node"; id: string; set: Partial<Omit<MapNode, "id">> }
  | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: MapEdge }
  | { op: "update_edge"; id: string; set: Partial<Omit<MapEdge, "id">> }
  | { op: "remove_edge"; id: string }
  | { op: "add_group"; group: MapGroup }
  | { op: "update_group"; id: string; set: Partial<Omit<MapGroup, "id">> }
  | { op: "remove_group"; id: string };

export type ProposalState = "pending" | "applied" | "rejected";
export interface Source {
  kind: "agent-turn" | "git-diff" | "human" | "import";
  session?: string;
  turn?: number;
  summary: string;
}
export interface Proposal {
  id: number;
  base_rev: number;
  created: string;
  source: Source;
  ops: Op[];
  state: ProposalState;
  decided_by: "human" | null;
  reason?: string;
}
export interface HistoryEntry {
  rev: number;
  applied: string;
  proposal: number | null;
  source: Source;
  ops: Op[];
  decided_by: "human";
  /** Present only on rev 0: the initial full snapshot that later revs replay from. */
  snapshot?: MapDoc;
}

export type ErrorCode =
  | "INVALID"
  | "STALE"
  | "PIN_VIOLATION"
  | "NOT_FOUND"
  | "NOT_PENDING"
  | "EXISTS";
export class DesignError extends Error {
  code: ErrorCode;
  details: string[];
  constructor(code: ErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "DesignError";
    this.code = code;
    this.details = details;
  }
}
