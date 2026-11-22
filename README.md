# design-loop

A live, versioned design map that follows your coding agent's session.

The agent proposes changes to a typed map of your system. You see what happened, what is
happening, and where it might go wrong. Nothing changes until you apply it, and anything
you place by hand stays where you put it.

**Status: early design. Nothing is implemented yet.** The schema draft is in
[`schema/design-map-v0.md`](schema/design-map-v0.md).

## How it works

- `.design/map.yaml` is the source of truth. Layout is not stored in it.
- `.design/pins.yaml` is human-only. The agent has no write path to it.
- The agent can only call MCP tools, mainly `map_propose`. A proposal is a list of granular
  operations against a base revision, written to `.design/proposals/`.
- Applying a proposal appends to `.design/history/`. Every entry records the session, the
  turn and a one-line reason.
- `.design/signals.json` is computed from the code (cites that moved or went missing), not
  from the model's opinion.

## Layout

| Path | Purpose |
|---|---|
| `core/` | schema, diff, pin merge, signals. No I/O beyond files |
| `mcp/` | MCP server, the agent's only write path |
| `cli/` | hook and CI entry point over the same core |
| `viewer/` | static page that watches `.design/` |
| `schema/` | the map format |
| `styles/` | visual language and diagram references |
| `scripts/` | geometry, contrast and render checks |

## Credit

The visual language derives from
[cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT). See
`NOTICE`.
