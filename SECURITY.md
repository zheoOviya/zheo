# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in SnakZap, please do **not** open a
public issue. Instead, report it privately by emailing the maintainers or
opening a private advisory via the GitHub "Security" tab of the repository.

Please include:

- A description of the vulnerability and the affected component/version.
- Steps to reproduce.
- Impact assessment (data exposed, privilege level, etc.).

We will acknowledge receipt within 5 business days and coordinate a fix and
disclosure timeline with you.

## Supported Versions

This is a portfolio/startup-grade monorepo. The current `main` branch is the
only supported line.

| Version | Supported |
| ------- | --------- |
| main    | Yes       |
| other   | No        |

## Security Model (summary)

- **Auth:** JWT access (15 min) + rotating refresh tokens with jti replay
  detection and device fingerprinting.
- **RBAC:** Route-level authorization for vendor and admin surfaces
  (`VENDOR_OWNER`, `VENDOR_STAFF`, `ADMIN`, `SUPER_ADMIN`); destructive admin
  actions are SUPER_ADMIN-gated.
- **Webhooks:** HMAC-SHA256 signature verification (Razorpay, Petpooja) plus
  idempotency keys.
- **Secrets:** All credentials come from environment variables; nothing is
  committed. `ALLOW_DEV_AUTH_BYPASS` refuses to enable in production.
- **Rate limiting:** Redis sliding window, fail-open for general API traffic
  and fail-closed on auth, payments, and admin-write endpoints.
