# Contributing to SnakZap

Thanks for your interest in contributing to SnakZap. This is a pickup-first
food ordering platform monorepo. The sections below cover how to run, test,
and submit changes.

## Development Setup

Prerequisites: Node.js >= 20 (see `.nvmrc`), pnpm >= 9.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Service ports: Consumer :3000, API :3001, Vendor :3002, Admin :3003.
PostgreSQL and Redis are optional for development (in-memory repositories are
seeded with demo data).

## Commands

| Command                | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `pnpm dev`             | Run all apps in dev mode (Turbo)           |
| `pnpm build`           | Production build of all packages           |
| `pnpm lint`            | ESLint across the workspace                |
| `pnpm typecheck`       | TypeScript check across the workspace      |
| `pnpm test`            | Vitest unit/integration tests (watch)      |
| `pnpm exec vitest run` | Vitest unit/integration tests (single run) |
| `pnpm test:e2e`        | Playwright end-to-end specs                |

Run a single test file with the workspace filter:

```bash
pnpm exec vitest run <path>
pnpm --filter @snakzap/consumer exec vitest run <path>
```

The e2e suite needs the API to boot with `RATE_LIMIT_OTP_PER_MINUTE=50` (see
`playwright.config.ts`) so OTP rate limits do not flake. Run `pnpm dev` first
or let Playwright reuse/start the server.

## Code Style

- Prettier defaults (2-space indent, single quotes, trailing commas).
- Run `pnpm format` before submitting; CI enforces `pnpm format:check`.
- No `console.log` in committed code; use the structured logger in
  `apps/api/src/lib/logger.ts`.
- TypeScript strict mode is on. Typecheck must pass.

## Architecture Notes

- Seven bounded contexts (Identity, Catalog, Ordering, Payments, Fulfillment,
  Loyalty, Vendor Ops); each owns its routes, services, and repositories.
- Cross-context communication is via injected repositories and the Redis
  Pub/Sub event bus (see `packages/types/src/events.ts` for the catalog).
- In development, in-memory repositories stand in for PostgreSQL.

## Submitting Changes

1. Branch from `main` using the convention `YYMMDD-<type>-<description>`.
2. Keep changes focused; one logical change per PR.
3. Ensure `pnpm lint`, `pnpm typecheck`, `pnpm build`, unit tests, and the
   relevant e2e specs pass.
4. Open a pull request with a clear description of the change and why it is
   needed.
