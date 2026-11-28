# Replay, layer 2: gopass / claude / prompt2-b-1-mx0061er

prompt 39ed3ca65035 / golden b04ead44b0 / estimated API cost $0.58 (not billed on a subscription)

| # | checkpoint | expect | new code mapped | drifted nodes cleared | new deps drawn (strict / either way) | unevaluable deps | churn | map changes | rejected |
|---|---|---|---|---|---|---|---|---|---|
| 1 | age agent launcher | may | 1/1 | 1/1 | 1/1 / 1/1 | 1 | 0 | 3 | 0 |
| 2 | age identity file refactor | noise | - | 4/4 | - / - | 0 | 0 | 4 | 0 |
| 3 | AuditList in the public API | may | - | 2/2 | - / - | 5 | 0 | 2 | 0 |
| 4 | HIBP into pkg/hibp (ADR A-16) | must | 2/2 | - | 0/1 / 0/1 | 4 | 0 | 1 | 0 |
| 5 | goeol version check | noise | 1/1 | - | - / - | 0 | 0 | 1 | 0 |
| 6 | CONTROL 1: 22 commits, 10 touch Go, no architectural change | control | - | - | - / - | 0 | 0 | 0 | 0 |
| 7 | age identity order | noise | - | 1/1 | - / - | 0 | 0 | 1 | 0 |
| 8 | Linux Secret Service daemon | must | 1/1 | 1/1 | 3/5 / 3/5 | 3 | 0 | 5 | 0 |
| 9 | buildinfo + age agent hello | may | 1/1 | 1/1 | 1/1 / 1/1 | 2 | 0 | 3 | 0 |
| 10 | go-git backend (ADR A-17) | must | - | 0/1 | 1/5 / 2/5 | 5 | 0 | 3 | 0 |
| 11 | gpg timeout config | noise | - | 0/1 | 1/1 / 1/1 | 0 | 0 | 1 | 0 |
| 12 | CONTROL 2: 22 commits, 10 touch Go, no architectural change | control | - | 1/1 | - / - | 0 | 0 | 1 | 0 |
| 13 | to golden commit | may | - | - | - / - | 1 | 0 | 0 | 0 |

**Totals.** New code mapped 100% (6/6, not counting carry-overs). Drift: 11 episodes, 10 fixed in the checkpoint they appeared, 11 fixed eventually, 0 never; mean 1.2 checkpoints open. New dependencies drawn 50% strict, 57% either way (21 more had an endpoint no node covers). Churn 0. Map changes on the 2 control checkpoints: 0 (should be 0). On noise checkpoints: 7. Rejected proposals 0.

**Golden preserved (32 nodes, 28 edges, rev 12).** The run starts from the golden map, so this checks the agent kept it intact; it does not measure discovery. Node recall 1 (core 1), edge recall 0.95 strict / 0.95 lenient, cite validity 1.

## 4. HIBP into pkg/hibp (ADR A-16)

- dependency not drawn: pkg-hibp -> ctxutil

## 8. Linux Secret Service daemon

- dependency not drawn: secretservice -> pkg-gopass
- dependency not drawn: secretservice -> secrets

## 10. go-git backend (ADR A-17)

- drift left: backend
- dependency not drawn: action -> gogit
- dependency not drawn: gogit -> config
- dependency not drawn: gogit -> ctxutil

## 11. gpg timeout config

- drift left: backend
