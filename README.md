<p align="center"><img src="assets/logo.svg" width="112" alt="design-loop logo: three map nodes joined into a loop"></p>

# design-loop

A live, versioned design map that follows your coding agent's session.

The agent proposes changes to a typed map of your system. You see what happened, what is
happening, and where it might go wrong. Nothing changes until you apply it, and anything
you place by hand stays where you put it.

**Status: early.** Core, MCP server, CLI, viewer and Stop hook are implemented and tested, and benchmarked on real
history ([results](bench/README.md)). This repo maps itself (`.design/`); longer real-session use is next.
The map format is in [`schema/design-map-v0.md`](schema/design-map-v0.md).

## Quick start

Needs Node 22.18+ and `npm install` in this repo. In the repo you want to map, from a real terminal
(decision commands refuse to run from an agent's shell):

```bash
DL=/path/to/design-loop
node $DL/cli/src/bin.ts init architecture "My system"            # 1. create .design/
claude mcp add design-loop -- node $DL/mcp/src/bin.ts "$(pwd)"    # 2. give your agent the MCP tools
# 3. ask the agent for a first map (map_propose), then review and apply it:
node $DL/cli/src/bin.ts review 1 && node $DL/cli/src/bin.ts apply 1
node $DL/cli/src/bin.ts coverage .ts src                         # 4. AFTER the first map: flag new code no node covers
node $DL/cli/src/bin.ts view                                     # 5. keep the live map open while you work
```

Enable coverage after the first map is applied: it acknowledges whatever is uncovered at that moment, so enabling
it on an empty map would mark all your code as deliberately unmapped. Commit `.design/` (`signals.json` is
computed; ignore it).

## How it works

- `.design/map.yaml` is the source of truth. Layout is not stored in it.
- `.design/pins.yaml` is human-only. The agent has no write path to it.
- The agent can only call MCP tools, mainly `map_propose`. A proposal is a list of granular
  operations against a base revision, written to `.design/proposals/`.
- Applying a proposal appends to `.design/history/`. Every entry records the session, the
  turn and a one-line reason.
- `.design/signals.json` is computed from the code (cites that moved or went missing, and, if you
  enable coverage, new code that no node covers), not from the model's opinion.

## Use the MCP server

Needs Node 22.18+ and `npm install` in this repo. Register it with Claude Code, pointing at the
repo whose `.design/map.yaml` you want to track:

```bash
claude mcp add design-loop -- node /path/to/design-loop/mcp/src/bin.ts /path/to/your/repo
```

Tools: `map_status`, `map_read`, `map_propose`, `map_history`, `map_diff`, `map_explain_node`.
There is deliberately no tool to apply or reject a proposal, or to touch pins. Those are human
decisions, made in the CLI or the viewer.

## Use the CLI and viewer

```bash
node cli/src/bin.ts init architecture "My system"   # in your repo, from a terminal
node cli/src/bin.ts view                            # prints a private link; Ctrl-C to stop
node cli/src/bin.ts status | review <id> | apply <id> | reject <id> | pin <node> <x> <y> | lock <node>
node cli/src/bin.ts coverage .go internal pkg       # flag NEW code no node covers (today's gaps are acknowledged)
node cli/src/bin.ts ack internal/goeol              # seen it, deliberately not mapping it
```

Decision commands (`init`, `apply`, `reject`, `rebase`, `pin`, `lock`, `coverage`, `ack`, `view`) refuse to run unless
both stdin and stdout are a terminal, so an agent's shell cannot approve its own changes. The viewer
binds to 127.0.0.1, needs a random per-session token that is only printed to your terminal, checks
Host and Origin, and renders agent-written text with `textContent` under a strict CSP.

Optional Stop hook, in your repo's `.claude/settings.local.json` (refreshes signals each turn; blocks once if
code the map cites has changed, or new code appeared that no node covers):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /path/to/design-loop/cli/src/bin.ts --root \"$CLAUDE_PROJECT_DIR\" hook stop" } ] } ] } }
```

## Does it work?

Tested on 195 real commits of gopass: with the `uncovered` signal on, an agent mapped every new component,
fixed drift promptly and changed nothing on control checkpoints. Method, numbers and limits: [`bench/README.md`](bench/README.md).

## Layout

| Path | Purpose |
|---|---|
| `core/` | schema, diff, pin merge, signals. No I/O beyond files |
| `mcp/` | MCP server, the agent's only write path |
| `cli/` | human decisions and the Stop hook, over the same core |
| `viewer/` | local server and page that show `.design/` live |
| `bench/` | benchmark harness, golden maps and results ([README](bench/README.md)) |
| `.design/` | this repo's own design map |
| `schema/` | the map format |
| `styles/` | visual language and diagram references |
| `scripts/` | geometry, contrast and render checks |

## Credit

The visual language derives from
[cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT). See
`NOTICE`.
