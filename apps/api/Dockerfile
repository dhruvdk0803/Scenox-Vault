# syntax=docker/dockerfile:1.7
#
# Scenox Vault API + worker image (one image, two commands).
#   api    : node dist/server.js   (default CMD)
#   worker : node dist/worker.js   (compose overrides `command`)
#
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t scenox-vault-api .

ARG NODE_VERSION=22

# ───────────── base: node + pnpm via corepack ─────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# ───────────── build: install workspace deps, compile with tsup, deploy prod tree ─────────────
FROM base AS build
# Manifests first so the dependency layer is cached until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@scenox/api..." --store-dir /pnpm/store

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# served at GET /api/docs; tsup copies it into dist/ (see apps/api/tsup.config.ts)
COPY docs/DEVELOPER_API.md docs/DEVELOPER_API.md
RUN pnpm --filter @scenox/api build \
 # Self-contained production tree (prod deps only, incl. prebuilt @node-rs/argon2 binaries for glibc)
 && pnpm --filter @scenox/api deploy --legacy --prod /out \
 # deploy copies the package directory (incl. the freshly built dist/ and drizzle/ migrations); assert it
 && test -f /out/dist/server.js && test -f /out/dist/worker.js && test -f /out/dist/DEVELOPER_API.md && test -f /out/drizzle/meta/_journal.json

# ───────────── runtime ─────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    STORAGE_PATH=/data/storage
# PID 1 handling (signal forwarding + zombie reaping) is done by Docker's built-in tini:
# compose sets `init: true`; with plain docker run use `--init`.
# Pre-create the storage mount point owned by `node` so a fresh named volume inherits writable perms.
RUN mkdir -p /data/storage && chown -R node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
COPY --from=build --chown=node:node /out/package.json ./package.json

USER node
VOLUME ["/data/storage"]
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
