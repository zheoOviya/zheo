# Changelog

All notable changes to SnakZap are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project targets [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- CI hardening: build gate, coverage step, and Playwright e2e step in
  `.github/workflows/ci.yml`.
- Containerization: multi-stage `Dockerfile` for the API, `docker-compose.yml`
  (PostgreSQL + Redis + API), and `.dockerignore`.
- CORS wildcard host support (`CORS_WILDCARD_HOSTS`) for hosted preview
  origins.
- Production guards in Razorpay and Petpooja mock modes: they now refuse to
  start in `NODE_ENV=production` without real credentials.
- Repo hygiene: `.editorconfig`, `.nvmrc`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CHANGELOG.md`, `.github/CODEOWNERS`; updated `.env.example` and `.gitignore`.

### Fixed

- Session hydration gap: suspension banner now renders on public pages after
  reload (`AccountEntry`/`AuthGate` chain `fetchMe`).
- OTP login flake: `sendSms` no longer makes a real (and failing) SMS provider
  call when the on-screen demo OTP is active; login can no longer fail with
  "Failed to send OTP" due to a slow/unreachable gateway.
- `.env.example` documented `PETPOOJA_*`, `S3_*`, `CORS_*`,
  `GOOGLE_MAPS_API_KEY`, and rate-limit variables; removed misleading docs.
- README test counts updated to the actual suite size (742 unit tests / 92
  files; 18 Playwright e2e specs).

### Removed

- Dead `.eslintrc.cjs` (the active config is the flat `eslint.config.mjs`).

## [0.0.0] - 2026-08-01

### Added

- Initial monorepo scaffold: Express API, Next.js consumer/vendor/admin apps,
  shared packages (config, db, types, ui).
- Phase 1 MVP (auth, catalog, ordering, payments, fulfillment, pickup
  verification, settlements), Phase 2 (POS, insights, loyalty), Phase 3
  (growth features), Phase 4 (scale features), admin governance, and UX
  sprints. See `README.md` for the full feature list.
