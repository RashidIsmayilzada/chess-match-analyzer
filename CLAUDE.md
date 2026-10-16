# chess-analyzer

Read `docs/ARCHITECTURE.md` first. It is the contract between packages: shared types,
classification rules, HTTP API, database schema and UI routes.

## Rules

- TypeScript, ESM. Inside a package use relative imports with `.js` extensions (NodeNext).
- `packages/core` has no I/O besides spawning the engine and reading the openings TSVs. No HTTP, no DB.
- Shared types live in `packages/core/src/types.ts`. Do not duplicate them elsewhere; import from `@chess-analyzer/core`.
- All tunable numbers go in `packages/core/src/config/thresholds.ts`. No magic numbers in classifier code.
- Engine scores are white POV. Win probabilities are mover POV, 0..1.
- Tests: vitest. Classifier logic is developed test-first with fixture positions.
- Commit small, descriptive commits.
- Run `npm run typecheck` and `npm test` before declaring work done.
