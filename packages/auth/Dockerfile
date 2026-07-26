# ============================================================
# BUILDER — install workspace dependencies (root context: npm
# workspaces need the root lockfile, same pattern as the engine's
# ../../Dockerfile)
# ============================================================

FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/

RUN npm ci --omit=dev --workspace=@vimp/auth

# ============================================================
# RUNNER — Production Image
# ============================================================

FROM node:24-slim AS runner

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY packages/auth ./packages/auth

ENV NODE_ENV=production

WORKDIR /app/packages/auth

# env vars (VIMP_AUTH_*, RS256 keys mounted under .keys/) come from
# docker-compose's env_file/volumes, not baked in — see docs/en/deployment.md.
# Migrations are a separate one-off (`node src/db/migrate.js`), not run on
# every container start, so a failed migration doesn't flap the service
CMD ["node", "src/main.js"]
