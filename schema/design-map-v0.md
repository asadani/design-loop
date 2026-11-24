# Design map schema, v0 draft

Working name: `.design/` (repo name still undecided).

## Layout on disk

```
.design/
  map.yaml            # current state. Source of truth. Agent proposes, human applies.
  pins.yaml           # human-only channel. The agent has no write path to it.
  coverage.yaml       # optional, human-only: which folders hold code, and code a human chose not to map
  proposals/          # pending agent changes, one file each, never auto-applied
    0007.yaml
  history/            # append-only, one file per applied change
    0006.yaml
  signals.json        # computed, never hand-written (drift, risk). Regenerated.
```

Rule: `map.yaml` is only written by `apply`. The agent writes `proposals/`.
Rule: git tracks `.design/` except `signals.json`.

## map.yaml

```yaml
version: 1
kind: architecture          # architecture | sequence | state | dataflow | flowchart | dependency
title: Checkout service
rev: 6                      # = number of the last applied history entry
nodes:
  - id: api
    label: Checkout API
    role: backend           # fixed vocabulary per kind; drives style, not layout
    status: stable          # planned | in-progress | stable | deprecated
    cites:                  # drift anchors
      - { path: src/api/checkout.ts, lines: [10, 80], hash: "sha256:9f2c..." }
    note: Validates cart, calls payments.
  - id: queue
    label: Order queue
    role: messagebus
    status: in-progress
edges:
  - { id: e1, from: api, to: queue, label: enqueue, kind: async }
groups:
  - { id: backend, label: Backend, members: [api, queue] }
```

Layout is not stored here. Auto-layout runs when no pin exists.

## pins.yaml (human-only)

```yaml
pins:
  api:   { x: 240, y: 120 }
  queue: { x: 480, y: 120 }
hidden: [e3]                # edges the human chose to hide
locked_labels: [api]        # the agent may not rename these
```

Pins refer to node ids. If the agent deletes a node, its pin is kept and marked orphaned, so
undo restores the position.

## Proposal / history entry

```yaml
id: 7
base_rev: 6                 # a proposal on a stale base must be rebased, not applied
created: 2026-11-22T10:14:00Z
source:                     # why this change exists
  kind: agent-turn          # agent-turn | git-diff | human | import
  session: abc123
  turn: 14
  summary: Switched order storage from Postgres to DynamoDB and added a queue.
ops:                        # granular, so the diff is exact
  - { op: add_node,    node: { id: queue, label: Order queue, role: messagebus, status: planned } }
  - { op: update_node, id: db, set: { label: DynamoDB orders, role: database } }
  - { op: add_edge,    edge: { id: e4, from: api, to: queue, kind: async } }
  - { op: remove_edge, id: e2 }
state: pending              # pending | applied | rejected | superseded
decided_by: null            # human | auto (only for ops that touch no pinned node)
```

Ops allowed: `add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`,
`remove_edge`, `add_group`, `update_group`. No whole-file replace.

## signals.json (computed)

```json
{
  "rev": 6,
  "computed": "2026-11-22T10:15:00Z",
  "signals": [
    { "node": "api", "type": "cite-moved",   "severity": "warn", "detail": "src/api/checkout.ts changed since a1b2c3d" },
    { "node": "queue", "type": "no-cite",    "severity": "info", "detail": "in-progress node has no code reference" },
    { "node": "db",    "type": "cite-missing","severity": "high", "detail": "src/db/orders.ts deleted" },
    { "node": "", "path": "src/billing", "type": "uncovered", "severity": "warn", "detail": "src/billing: 6 source files in 2 folders that no node covers" }
  ]
}
```

Signal types in v0 (all deterministic, no model judgement):
`cite-moved`, `cite-missing`, `no-cite`, `stale-planned` (still planned 5 revs later), and `uncovered`
(only when `coverage.yaml` exists: a source folder under a watched root that no cite covers and no human
acknowledged; `node` is empty and `path` names the folder; a folder and its uncovered sub-folders are one signal).
Deferred: `orphan-edge` (validation already forbids it) and `unpinned-after-human-edit`.

## coverage.yaml (optional, human-only)

```yaml
roots: [internal, pkg]        # folders where code lives, relative to the repo root ("." = everything)
extensions: [.go]             # files that count as source; tests, testdata, vendor and dotfiles never count
acknowledged: [internal/legacy, pkg/debug]   # seen, deliberately unmapped; everything inside is ignored
```

Cite signals only watch code the map already points at, so a new component is invisible to them. This file
closes that gap. `design-loop coverage .go internal pkg` creates it and acknowledges everything uncovered at
that moment, so only code that appears later is flagged. A signal clears when an applied proposal cites the
folder, or when a human runs `design-loop ack <folder>`. Like pins, no agent-facing path writes this file.

## Views

| Question | Reads | Shows |
|---|---|---|
| What happened | `history/` | timeline of entries, each with its summary and a diff between any two revs |
| What is happening | `map.yaml` + `proposals/` | current map; changed nodes highlighted; pending proposals as an overlay with Apply / Reject |
| Where it might go wrong | `signals.json` | badges on nodes, sorted list by severity |

## Decisions (locked)

1. `role` is a closed vocabulary per kind (see `core/src/types.ts`).
2. Cites store a content hash of the cited lines, trailing whitespace ignored. Filled in when a change is applied.
3. Every change needs human approval. There is no auto-apply.
4. `pins.yaml`, `locked_labels` and `coverage.yaml` are human-only; no agent-facing path writes them.

## Behaviour notes (implemented in core)

- A proposal must name the current `base_rev` or it is refused (`STALE`). Stale pending proposals can be rebased if their ops still apply.
- A proposal is dry-run against the map and pins when created, so a bad one is refused at once and never saved.
- Removing a node that still has edges or group membership is refused; the blockers are listed.
- History replays from a full snapshot at rev 0, so any past rev can be rebuilt and diffed.

## Open questions

1. Do sequence/state need a different node model, or can `kind` select a sub-schema as archify does?
2. Cites of directories hash the file listing (non-test, non-hidden files), not contents. Symlinked cite targets count as missing.
