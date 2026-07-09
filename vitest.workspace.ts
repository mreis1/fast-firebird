// Root workspace so `vitest` invoked from the repo root applies each package's
// own config (timeouts, single-fork runner) instead of falling back to
// defaults (5s timeout + parallel files), which flakes the integration suite.
// Prefer `pnpm test`; this makes a bare root `vitest run` safe too.
export default ['packages/*'];
