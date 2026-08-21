# syntax=docker/dockerfile:1

# ============================================================
# SnakZap API - production image.
#
# Builds the Express API (@snakzap/api) together with its
# workspace TypeScript dependencies (config/db/types) using
# pnpm, then runs the compiled dist with plain node.
# ============================================================

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

# ---- deps: install with a frozen lockfile from manifests ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile the API (workspace TS is compiled into dist) ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm --filter @snakzap/api build

# ---- runtime: minimal image with compiled code + prod deps ----
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/turbo.json ./
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/packages ./packages
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3001/health || exit 1
CMD ["node", "apps/api/dist/index.js"]
