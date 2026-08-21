# Repo Standards Audit & Remediation — 2026-08-21

**Scope:** CI pipeline, containerization, repo hygiene, and security hard stops
across the SnakZap monorepo.

**Context:** This session executed the remediation plan approved from the
preceding audit. Every claim below was verified with an actual command run;
results are recorded inline.

---

## 1. Audit Findings (baseline)

| # | Finding | Severity | Status |
|---|---|---|---|
| A1 | CI ran lint/typecheck/unit only; no `build` gate, no coverage, no e2e | Medium | Fixed |
| A2 | No Dockerfile / docker-compose / .dockerignore | Medium | Fixed |
| A3 | README test counts stale (386/45 vs actual 742/92 + 18 e2e) | Low | Fixed |
| A4 | `.env.example` missing `PETPOOJA_*`, `S3_*`, `CORS_*`, `GOOGLE_MAPS_API_KEY`, rate-limit vars | Low | Fixed |
| A5 | `.gitignore` missing `.env.production` / `.env.test` | Medium | Fixed |
| A6 | Missing standard files: CONTRIBUTING, SECURITY, CHANGELOG, CODEOWNERS, .editorconfig, .nvmrc | Low | Fixed |
| A7 | Dead `.eslintrc.cjs` (flat `eslint.config.mjs` is active) | Low | Fixed (removed) |
| A8 | CORS allowlist lacked hosted-preview origins (`*.monkeycode-ai.live`) | Medium | Fixed |
| A9 | Razorpay/Petpooja mock modes silently active in production without real keys | Medium | Fixed |
| A10 | No test coverage gate in CI | Low | Fixed |

**Corrected claim (audit review):** WebSocket is **authenticated** server-side
(`apps/api/src/lib/websocket.ts` `authenticateConnection` + per-subscription
authorization) — the earlier draft called it unauthenticated. No fix needed.

---

## 2. Remediation

### 2.1 CI hardening — `.github/workflows/ci.yml`
- Added `pnpm build` production-build gate.
- Added `vitest run --coverage` with thresholds (see 2.5).
- Added frontend unit suites (`@snakzap/consumer|vendor|admin`).
- Added Playwright install + `pnpm test:e2e` with `RATE_LIMIT_OTP_PER_MINUTE=50`.
- Timeout raised 15 → 30 min.

### 2.2 Containerization
- `Dockerfile`: multi-stage pnpm build of `@snakzap/api` (workspace TS deps
  compile into `dist`); runtime image runs `node apps/api/dist/index.js` with a
  `/health` check.
- `docker-compose.yml`: PostgreSQL 16 + Redis 7 + API; requires
  `JWT_SECRET`/`JWT_REFRESH_SECRET`; documents payment creds needed in prod.
- `.dockerignore`: excludes node_modules, build outputs, env files, CI/docs.

### 2.3 Repo hygiene
- README: test counts updated (742 unit / 92 files; 18 Playwright e2e).
- `.env.example`: added `PETPOOJA_*`, `S3_*`, `CORS_ORIGINS`,
  `CORS_WILDCARD_HOSTS`, `GOOGLE_MAPS_API_KEY`, `RATE_LIMIT_*`.
- `.gitignore`: added `.env.production` / `.env.test` / `.env.staging` /
  `.env.development`; `!.env.example`.
- Added: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`,
  `.github/CODEOWNERS`, `.editorconfig`, `.nvmrc`.
- Removed dead `.eslintrc.cjs` (no references; confirmed with repo-wide grep).

### 2.4 Security hard stops
- `apps/api/src/config.ts` + `apps/api/src/app.ts`: CORS now exact-match from
  `CORS_ORIGINS` plus wildcard host suffixes from `CORS_WILDCARD_HOSTS`
  (defaults to `monkeycode-ai.live` for hosted previews).
- `apps/api/src/services/razorpay.ts` and `posPetpooja.ts`: throw at boot in
  `NODE_ENV=production` when real credentials are missing (mock mode is a
  dev/test-only seam, never for real traffic).

### 2.5 Coverage gate
- Root `vitest.config.ts` `test.coverage`: v8 provider, `json-summary`
  reporter, scoped `include` to `apps/api` + `packages/db` + `packages/types`
  (frontends run under their own configs and are excluded here).
- Thresholds set from measured baseline with ~8-9% margin:

  | Metric | Baseline | Threshold |
  |--------|----------|-----------|
  | lines / statements | 78.6% | 70% |
  | branches | 78.4% | 70% |
  | functions | 73.8% | 65% |

### 2.6 E2E login flake (found during verification)
- Root cause: `apps/api/src/services/otp.ts` `sendSms` made a real MSG91 HTTP
  call (5s timeout) even when no SMS key is configured. A slow/failing call
  returned `sent: false`, and the consumer login UI treated that as a hard
  failure ("Failed to send OTP") instead of proceeding to the on-screen OTP.
- Fix: short-circuit `sendSms` to `true` when the dev/preview on-screen OTP is
  active (the demo code IS the delivery channel). Production behavior is
  unchanged (the bypass is never active there).

---

## 3. Verification (evidence)

| Gate | Result |
|------|--------|
| `pnpm --filter @snakzap/api build` | PASS |
| `pnpm build` (Turbo, all packages) | PASS (4 tasks) |
| `pnpm lint` (api, consumer) | PASS |
| `pnpm --filter @snakzap/consumer typecheck` | PASS |
| `pnpm exec vitest run --coverage` (with thresholds) | PASS |
| Root unit suite (incl. 4 new CORS tests) | 533 PASS |
| Consumer / vendor / admin unit suites | 130 / 35 / 48 PASS |
| New CORS tests (`apps/api/src/__tests__/cors.test.ts`) | 4/4 PASS |
| `pnpm test:e2e` (Playwright, 18 specs) | 18/18 PASS |
| `pnpm exec prettier --check` on touched files | PASS (authored files) |

---

## 4. Remaining / Notes

- The pre-fix e2e runs showed 17/18 twice: once a consumer-profile login flake
  and once a cross-agent login flake — both traced to the `sendSms` issue fixed
  in 2.6 (the critical cross-agent suspension-banner spec passed on one run).
- `RATE_LIMIT_OTP_PER_MINUTE=50` is required for the e2e OTP flows; default
  stays 3/min for production safety.
- `docker compose up --build` needs a smoke run on a Docker host (not available
  in this environment).
- Prettier debt (199 pre-existing files) is intentionally left untouched; CI
  does not enforce `format:check`.
