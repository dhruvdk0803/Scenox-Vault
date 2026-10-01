# syntax=docker/dockerfile:1.7
#
# Scenox Vault web (Next.js 16, standalone output).
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t scenox-vault-web .

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@scenox/web..." --store-dir /pnpm/store

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# next.config.ts rewrites() is evaluated at BUILD time and baked into the standalone server.
# In production Caddy routes /api/* straight to the API, so this is only a fallback.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN mkdir -p apps/web/public && pnpm --filter @scenox/web build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# PID 1 handling: compose sets `init: true` (Docker's built-in tini); with docker run use `--init`.
WORKDIR /app
# Standalone output is rooted at the monorepo root: server lives at apps/web/server.js
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
