# Benchmark

Does design-loop keep a design map true while code changes? Tested on real history, not toy examples.

Working data (repo clones, stripped copies, full run transcripts) lives outside this repo, in
`../design-loop-bench` (override with `DESIGN_BENCH`). A snapshot of what is needed to reproduce and check the
results is in [`data/`](data): golden maps, the replay checkpoints, `make-stripped.sh` (pinned commits and what
it strips), and the reports behind the tables below. Golden maps were drafted from each project's own
architecture docs, which are removed from the copy the agent sees.

## What it measures

**Replay** (`replay.ts`, `replay-agent.ts`). gopass, 195 real commits from 2026-06-11 to 2026-11-22, after the
model's training cutoff. Grouped into 13 checkpoints, two of them controls (22 commits each, Go changes, no
architectural change). "Architectural change" is computed from the code: Go packages appearing or vanishing,
imports between components appearing or vanishing.

- Layer 1, signals only, free: does design-loop flag the change?
- Layer 2, an agent (Claude Code headless, Read/Glob/Grep plus the MCP server only) sees each checkpoint's
  commit subjects and changed paths and updates the map; an auto-approver applies its proposals. Scored against
  the agent's own map.

**Cold start** (`run.ts`). An agent maps a stripped repo from scratch; scored against the golden map. Recall only:
the docs cover part of each system, so extra components are unjudged, not wrong.

## Results (gopass)

Layer 1, 42 architectural changes:

| | noticed | false alarms | signals on controls |
|---|---|---|---|
| cite signals only | 9 | 5 | 0 |
| + `uncovered` signal | 35 | 5 | 0 |
| + nested-cite fix | 35 | 2 | 0 |

Layer 2, three runs with the current prompt (`39ed3c`):

| | run A | run B | run C |
|---|---|---|---|
| new components mapped | 6/6 | 6/6 | 6/6 |
| drift fixed in the checkpoint it appeared | 10/11 | 10/11 | 11/11 |
| drift fixed eventually | 11/11 | 11/11 | 11/11 |
| new dependencies drawn (strict) | 50% | 50% | 44% |
| churn (unjustified edits) | 0 | 0 | 0 |
| changes on control checkpoints | 0 | 0 | 0 |

Scorer checks: an oracle agent scores 100% with zero churn, an idle agent 0%.

Cold start (3 runs each): node recall 0.46 on gopass (0.69 on components the golden connects), 0.63 on
swagger-php; every cite pointed at real code.

## What the benchmark changed in the tool

- `uncovered` signal: new code no node cites was invisible. Now caught (0/7 to 7/7 new packages).
- Nested cites: a change inside a child component flagged its parent too, and the parent stayed flagged.
- Hashes are server-owned: an agent echoing a stale hash back silently prevented re-anchoring.

## Limits

- One repo for the replay, Go only; three runs per setup.
- Dependency changes inside existing files are invisible to folder cites (`gpg-cli` starting to use `config`).
  The agent catches about half of new dependencies, mostly missing imports of small utility packages.
- Each checkpoint is a fresh agent session; real use is one ongoing conversation.
- The replay starts from the golden map, so it measures maintenance, not discovery.

## Running it

```bash
node bench/replay.ts signals ../design-loop-bench/replay/gopass.yaml                 # layer 1, free
node bench/replay-agent.ts --config ../design-loop-bench/replay/gopass.yaml \
  --label x --agent oracle|idle                                                      # scorer checks, free
caffeinate -i node bench/replay-agent.ts --config ../design-loop-bench/replay/gopass.yaml \
  --label x --agent claude --budget 0.5                                              # real agent
node bench/replay-agent.ts --config ../design-loop-bench/replay/gopass.yaml --rescore
node bench/run.ts --repo gopass --label cold --agent claude --budget 3 --runs 3      # cold start
node bench/report.ts
```

Runs use your Claude subscription. They refuse to start if an API key is set (`--allow-api-billing` overrides),
and `--budget` caps Claude Code's estimated API cost per session. Keep the lid open: a sleeping machine taints
the run.
