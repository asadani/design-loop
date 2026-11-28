# Replay, layer 1 (signals only): gopass from f25fc7b4, coverage signal ON

| # | checkpoint | expect | changes | noticed | silent, a node involved | silent, no node involved | signals | noise |
|---|---|---|---|---|---|---|---|---|
| 1 | age agent launcher (e398dd39) | may | 3 | 3 | 0 | 0 | 2 | 0 |
| 2 | age identity file refactor (2b095cb7) | noise | 2 | 2 | 0 | 0 | 4 | 1 |
| 3 | AuditList in the public API (451e9da8) | may | 7 | 2 | 3 | 2 | 2 | 1 |
| 4 | HIBP into pkg/hibp (ADR A-16) (d6bf336b) | must | 10 | 10 | 0 | 0 | 2 | 0 |
| 5 | goeol version check (0dfe851a) | noise | 1 | 1 | 0 | 0 | 1 | 0 |
| 6 | CONTROL 1: 22 commits, 10 touch Go, no architectural change (6b878ec3) | control | 0 | 0 | 0 | 0 | 0 | 0 |
| 7 | age identity order (00a2b4b9) | noise | 1 | 1 | 0 | 0 | 1 | 0 |
| 8 | Linux Secret Service daemon (f438c17f) | must | 11 | 11 | 0 | 0 | 2 | 0 |
| 9 | buildinfo + age agent hello (a8505c66) | may | 4 | 4 | 0 | 0 | 2 | 0 |
| 10 | go-git backend (ADR A-17) (76a213d4) | must | 1 | 1 | 0 | 0 | 1 | 0 |
| 11 | gpg timeout config (4fddbe58) | noise | 1 | 0 | 1 | 0 | 0 | 0 |
| 12 | CONTROL 2: 22 commits, 10 touch Go, no architectural change (f0c64f09) | control | 0 | 0 | 0 | 0 | 0 | 0 |
| 13 | to golden commit (f03c0d2f) | may | 1 | 0 | 1 | 0 | 0 | 0 |
| | **total** | | 42 | **35** | **5** | **2** | | **2** |

Noticed: a signal fired on a node involved in the change, or an "uncovered" signal named a package involved in it. Silent: no signal pointed at it,
split by whether a map node is involved. 7 of the changes are new packages no node covers. Noise: a signal tied to no architectural change.

## 1. age agent launcher

- noticed: new package internal/ageagentlauncher (no node covers it)
- noticed: + dependency ?. -> ?internal/ageagentlauncher
- noticed: + dependency ?internal/ageagentlauncher -> age
- signal: internal/ageagentlauncher: 3 source files in 1 folder that no node covers

## 2. age identity file refactor

- noticed: new package helpers/commitmsg (in helpers)
- noticed: new package internal/backend/crypto/age/identityfile (in age)
- noise: leaf-store flagged, no architectural change

## 3. AuditList in the public API

- SILENT, node involved: + dependency ?internal/audit -> root-store
- SILENT, node involved: + dependency ?internal/audit -> tree
- SILENT, node involved: + dependency api -> ?internal/audit
- silent, no node involved: + dependency ?internal/audit -> ?internal/store
- silent, no node involved: + dependency ?pkg/termio -> ?pkg/debug
- noticed: new package helpers/semdup (in helpers)
- noticed: new package helpers/semdup/analyzer (in helpers)
- noise: age flagged, no architectural change

## 4. HIBP into pkg/hibp (ADR A-16)

- noticed: new package pkg/hibp/api (no node covers it)
- noticed: new package pkg/hibp/dump (no node covers it)
- noticed: + dependency ?internal/audit -> ?pkg/hibp/api
- noticed: + dependency ?internal/audit -> ?pkg/hibp/dump
- noticed: + dependency ?pkg/hibp/api -> ?pkg/debug
- noticed: + dependency ?pkg/hibp/api -> ?pkg/fsutil
- noticed: + dependency ?pkg/hibp/api -> ?pkg/termio
- noticed: + dependency ?pkg/hibp/api -> ctxutil
- noticed: + dependency ?pkg/hibp/dump -> ?pkg/debug
- noticed: + dependency ?pkg/hibp/dump -> ?pkg/fsutil
- signal: pkg/hibp/api: 2 source files in 1 folder that no node covers
- signal: pkg/hibp/dump: 2 source files in 1 folder that no node covers

## 5. goeol version check

- noticed: new package internal/goeol (no node covers it)
- signal: internal/goeol: 1 source file in 1 folder that no node covers

## 7. age identity order

- noticed: new package internal/backend/crypto/age/identityorder (in age)

## 8. Linux Secret Service daemon

- noticed: new package internal/secretservice (no node covers it)
- noticed: new package internal/secretservice/crypto (no node covers it)
- noticed: + dependency ?internal/secretservice -> ?internal/notify
- noticed: + dependency ?internal/secretservice -> ?internal/secretservice/crypto
- noticed: + dependency ?internal/secretservice -> ?internal/store
- noticed: + dependency ?internal/secretservice -> ?pkg/debug
- noticed: + dependency ?internal/secretservice -> api
- noticed: + dependency ?internal/secretservice -> appdir
- noticed: + dependency ?internal/secretservice -> pkg-gopass
- noticed: + dependency ?internal/secretservice -> secrets
- noticed: + dependency action -> ?internal/secretservice
- signal: internal/secretservice: 14 source files in 2 folders that no node covers

## 9. buildinfo + age agent hello

- noticed: new package internal/buildinfo (no node covers it)
- noticed: + dependency ?. -> ?internal/buildinfo
- noticed: + dependency ?internal/buildinfo -> ?pkg/debug
- noticed: + dependency age -> ?internal/buildinfo
- signal: internal/buildinfo: 1 source file in 1 folder that no node covers

## 10. go-git backend (ADR A-17)

- noticed: new package internal/backend/storage/gogit (in backend)

## 11. gpg timeout config

- SILENT, node involved: + dependency gpg-cli -> config

## 13. to golden commit

- SILENT, node involved: + dependency cui -> ?internal/out
