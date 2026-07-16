# Contributing to fast-firebird

Thanks for your interest! This document covers how to get a working dev
environment, how the test matrix works, and what a good PR looks like.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm ≥ 9** (`corepack enable` is the easiest way)
- **Docker** with the compose v2 plugin (for integration tests)

## Getting started

```bash
git clone https://github.com/mreis1/fast-firebird
cd fast-firebird
pnpm install
pnpm fb:up      # starts the Firebird test matrix (see below)
pnpm build
pnpm test
```

## The Firebird test matrix

Integration tests run against **real Firebird servers** — Firebird 3, 4 and 5
plus a Legacy_Auth-only container — via `docker/docker-compose.yml`:

```bash
pnpm fb:up      # docker compose -p fast-firebird-test up -d --wait
pnpm fb:down    # removes ONLY this project's containers/volumes
```

Everything is namespaced under the compose project `fast-firebird-test`
(containers `fast-firebird-test-fb3/fb4/fb5/fblegacy`, ports 30503/30504/30505/30506
bound to 127.0.0.1). `pnpm fb:down` is scoped to that project and never
touches other Docker resources on your machine.

The same compose file drives CI (`.github/workflows/ci.yml`), so local and CI
environments cannot drift.

### Test expectations

- `pnpm test` — full suite. Core tests + Drizzle adapter tests, all green on
  FB3, FB4 **and** FB5. A change that passes on FB5 but breaks FB3 is not done.
- `pnpm test:unit` — no Docker needed (wire encoding, SRP vectors, type
  codecs, script parser, …).
- `pnpm test:integration` — needs the compose matrix up.
- `pnpm typecheck` — strict TypeScript across all packages.

Some tests assert **exact round-trip counts** (via `Attachment.roundTrips`).
If your change legitimately alters a round-trip profile, update the assertion
and say why in the PR — an unexplained extra round trip is treated as a
performance regression.

## Project layout

```
packages/core          the wire-protocol driver (publishable)
packages/drizzle       Drizzle ORM dialect on top of core (publishable)
packages/benchmarks    perf harness vs node-firebird (latency proxy, private)
apps/demo              live demo dashboard (private)
plans/ diary/          engineering plans + daily engineering diary
scripts/               codegen (gds messages) + docker cleanup
```

`plans/` and `diary/` are the maintainer's engineering record — you're welcome
to read them for context (they document *why* almost every design decision was
made), but PRs don't need to update them.

## Generated files — do not hand-edit

- `packages/core/src/protocol/messages.json` — gds-code → message map,
  generated from the Firebird sources by `scripts/generate-messages.mjs`.
- `packages/core/src/types/timezones.ts` — time-zone id table from Firebird's
  `TimeZones.h`. Zone ids are fixed by the Firebird project; regeneration
  notes are in the file header.

See `NOTICE` for the attribution that covers both.

## Pull requests

- **Keep PRs focused** — one logical change, no drive-by reformatting.
- **Add tests** for any behavior change. Integration tests should use the
  helpers in the existing suites (fresh-database helpers, retry-on-DDL-deadlock)
  rather than sharing tables between files.
- **Blob/charset/protocol work**: state which server versions you tested
  against. Protocol behavior genuinely differs between FB3 (protocol 15),
  FB4 (16) and FB5 (19).
- **Performance claims** need numbers — `packages/benchmarks` has a latency
  proxy harness (`pnpm --filter @fast-firebird/benchmarks bench`); round-trip
  counts matter as much as wall time.
- Match the surrounding code style; comments explain *constraints and why*,
  not what the next line does.

## Reporting bugs

Please use the bug-report issue template. The single most useful thing you
can include is a **minimal reproduction against a stock Firebird Docker
image** — failing that, the exact server version, charset configuration and
the full `FirebirdError` (it carries the gds code, SQLSTATE and status vector).

## Security issues

Please do **not** open public issues for security problems — see
[SECURITY.md](SECURITY.md).
