# Dockerfile for the AIHXM backend (apps/api) — used to deploy to Google
# Cloud Run as a lower-latency, no-cold-start alternative to Render's free
# tier. Built to be run with the REPO ROOT as the Docker build context
# (not this apps/api folder), because this is an npm-workspaces monorepo:
# `npm ci` needs the root package.json + package-lock.json to see every
# workspace, and the API build depends on packages/shared-types.
#
# To build and deploy from Cloud Run's "Deploy from source" flow, point it
# at this repo with:
#   - Build context: repo root (the top-level folder, NOT apps/api)
#   - Dockerfile path: apps/api/Dockerfile
#
# Mirrors render.yaml's buildCommand/startCommand exactly so the two
# platforms build identically:
#   build: npm install && npx turbo run build --filter=@ai-hxm/api
#   start: node apps/api/dist/main.js
#
# Cloud Run injects its own PORT env var at runtime (usually 8080) and
# expects the container to listen on it — apps/api/src/main.ts already
# reads process.env.PORT (same code path Render already uses), so no
# code change was needed for this to work on Cloud Run.

# ---- Builder: install every workspace's deps, build only @ai-hxm/api ----
FROM node:20-slim AS builder
WORKDIR /app

# Root workspace manifests first (better layer caching across rebuilds
# when only application source changes, not dependencies).
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# `npm ci` resolves workspaces from the root package.json's "apps/*" /
# "packages/*" globs — apps/web isn't copied into this image at all, so
# npm simply never sees it as a workspace member here (no error, and none
# of its heavier frontend dependencies get installed for the API image).
RUN npm ci

RUN npx turbo run build --filter=@ai-hxm/api

# ---- Runtime: copy the built output + node_modules, nothing else ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api

# Cloud Run sets PORT itself at runtime; this EXPOSE is documentation only.
EXPOSE 8080

CMD ["node", "apps/api/dist/main.js"]
