# Becoming the reference Firebird driver for Node.js

Draft 2026-07-20. Strategy, not a feature list. The premise: v0.1.0 is
technically strong and broadly feature-complete, but **unknown**. The gap to
"reference" is not features — it is discoverability, legible trust, and the
switching cost from node-firebird. This plan attacks those three, in order.

## Honest read of where we stand

**Strengths (real, and rare in this niche):** pure-TS, wire-first design with
round-trip discipline that is actually *asserted* in tests; a 4-real-server
matrix (FB3/4/5/6) with 1085+90 tests; byte-exact blob and CHARSET NONE
correctness; a Drizzle dialect; modern packaging (ESM+CJS, provenance).

**The problem is not the driver — it's the market position:**
1. **Nobody knows it exists.** 0.1.0 is 2 days old, no downloads, no inbound.
2. **node-firebird is the incumbent** and its 2.x line is modernizing fast
   (TS, promises, pool, batch). "Modern TypeScript" alone is no longer a moat.
3. **Firebird's userbase is conservative and loyal** — heavily ERP/LOB, strong
   in Brazil/LATAM. They do not switch drivers for novelty. They switch for
   (a) a low-friction path off what they have, (b) demonstrable correctness,
   (c) a real fix to a pain they feel — which for Firebird is bulk writes and
   blob/round-trip cost.

**Therefore the moat we can actually own** is architectural and evidentiary:
wire efficiency (measured, reproducible), correctness (the matrix as a public
artifact), and TS-first ergonomics — *packaged so a stranger can verify all
three in five minutes.*

## North star & positioning

One sentence, everywhere: **"The pure-TypeScript Firebird driver that treats
round trips as the scarcest resource — and proves it against real servers."**

Not "modern" (node-firebird is now modern too). The differentiators are
*measured efficiency* and *proven correctness*. Everything below serves making
those two legible and easy to adopt.

## Phase 0 — Launch readiness (do BEFORE advertising)

Advertising a thing a stranger can't evaluate or adopt in minutes wastes the
one-time novelty spike. Land these first:

1. **Documentation site.** The README is long and good but it's not a site.
   A docs site (VitePress/Astro/Docusaurus, deploy on GitHub Pages) buys SEO,
   a real API reference (TypeDoc from the d.ts), task-oriented guides, and
   credibility. This is table stakes for "reference." *Highest-leverage
   non-feature item.*
   **Status: BUILT 2026-07-21** (`docs/`, VitePress + TypeDoc, 19 guide pages,
   `.github/workflows/docs.yml` → GitHub Pages at
   https://mreis1.github.io/fast-firebird/). Goes live on push + enabling
   Pages (Source: GitHub Actions) in repo settings.
2. **node-firebird migration guide (public).** The single biggest adoption
   lever — the install base is on node-firebird. A side-by-side "here's your
   code, here's the fast-firebird version" page. We already have the internal
   `nf2-ext-integration.md` mapping table; generalize its public-API half into
   a guide. Decide separately whether to ship a thin **compat shim** package
   (`node-firebird`-shaped API over core) — powerful but a maintenance
   commitment; the guide comes first, the shim only if demand appears.
   **Status: guide BUILT 2026-07-21** (docs site,
   `guide/migrate-from-node-firebird`). Shim still demand-driven. The
   `examples/` directory (item 4) remains open.
3. **Reproducible benchmark repo/page.** The perf story (21–152× blobs, RT
   counts) is our strongest evidence but currently lives in plans/. Publish it:
   a runnable repo, methodology stated, "defaults vs defaults vs
   node-firebird 2.x", charts. Skeptics must be able to re-run it. This is the
   proof behind the positioning.
4. **`examples/` directory** — copy-pasteable, runnable: connect, CRUD, named
   params, streaming, blobs, pool, transactions, Drizzle. Lowers evaluation
   friction to near zero.
5. **Polish the npm/GitHub first impression** — keywords for search
   ("firebird", "firebirdsql", "interbase", "typescript", "driver"), social
   preview image, tight description, the phoenix brand already done.

## Phase 1 — The technical hook: wire batch API (backlog #17)

**Status: SHIPPED 2026-07-20** (`executeBatch`, plans/batch.md) — 300 rows in
one data round trip, asserted in tests. The launch hook exists; Phase 0 is
now the critical path.

The one feature that is both a genuine gap *and* a headline differentiator.
`op_batch_create/msg/exec` (FB4+/protocol 16): many rows inserted in **one
round trip**. Bulk insert is the write-side pain every Firebird ERP feels, and
it's exactly on-thesis. Shape it like `queryStream` (stream in, adaptive
flush); blob-in-batch can come later. This gives the launch a concrete "and
it's dramatically faster at the thing you do all day" beyond blobs.

Everything else stays demand-driven: multi-host pool (#18), qualified rows
(#19), JSON relational mode (#15, canary-gated).

## Phase 2 — Advertise (only after Phase 0, ideally with Phase 1 in hand)

Sequence matters. Land readiness, then one coordinated push, then sustain.

**Firebird's own channels (highest intent, do first):**
- Get listed on **firebirdsql.org**'s drivers/language-access page — the
  canonical place Firebird users look. Also the Firebird Project GitHub org.
- **firebird-devel** and **firebird-support** mailing lists; the Firebird
  **Telegram** groups; IBPhoenix.
- **Brazilian/LATAM community** — disproportionately large for Firebird. PT-BR
  content, local forums/Telegram/YouTube, is likely the single richest vein.

**Developer-general (breadth):**
- **Show HN** / **Reddit** (r/node, r/typescript, r/firebird), **dev.to**
  article. The hook is the benchmark + correctness matrix, not "new driver."
- The **Drizzle** community/docs — being a Drizzle dialect is a discovery path;
  get referenced in Drizzle's ecosystem list.

**Content as marketing (durable, compounding, SEO):**
- "Migrating from node-firebird" (the guide, also an article).
- "How we made Firebird blobs 100× faster" (the wire-first design story).
- "Testing a database driver against 4 real servers" (the correctness story).

**Rule:** every announcement points at the docs site and the benchmark repo.
Never advertise into a bare README.

## Phase 3 — Sustain & widen

- **More ecosystem adapters** by demand: Knex dialect, TypeORM, a Kysely
  dialect (Kysely's TS-first audience overlaps ours strongly).
- **Reference production users** — 2–3 real deployments + testimonials convert
  conservative buyers better than any benchmark.
- **Responsiveness** — fast issue triage in the first months sets the
  "maintained, trustworthy" reputation that *is* the reference status.
- **Keep the FB6 canary armed** — being first with correct FB6/schema/JSON
  support when 6.0 goes stable is a natural second news beat.

## Success signals (not vanity)

- Listed on firebirdsql.org drivers page.
- Weekly npm downloads on a sustained upward trend (not just a launch spike).
- Inbound issues/PRs from strangers (proof of real usage).
- At least one public project/blog adopting it, unsolicited.
- Showing up on the first page for "firebird node typescript".

## Division of labor

- **Driver/repo work (me):** docs site, migration guide, benchmark repo,
  examples, npm/GH polish, batch API, adapters. All reviewable in-repo.
- **Advocacy (Marcio, or me drafting):** posting to Firebird channels, the
  firebirdsql.org listing request, community/PT-BR outreach, responding as the
  author. I can draft every post; the identity and relationships are yours.

## Suggested order

1. Docs site scaffold + API reference + move the README guides into it.
2. Migration guide + `examples/`.
3. Benchmark repo/page (publish existing numbers, make re-runnable).
4. Batch API (#17).
5. Coordinated launch (Firebird channels → Show HN/Reddit/dev.to → Drizzle).
6. Sustain: adapters by demand, triage, FB6-stable beat.
