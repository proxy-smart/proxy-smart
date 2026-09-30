# Multi-stage build for Proxy Smart monorepo
# Single backend image serves API + all frontend apps (Admin UI, SMART apps, docs)
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

# Common build dependencies stage
FROM base AS build-deps
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    build-essential \
    pkg-config \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy root package files first. bunfig.toml is required so bun can map the
# @max-health-inc and @max-network scopes to GitHub Packages (and read
# $GH_PACKAGES_TOKEN); without it `bun install` cannot authenticate them and stalls.
COPY package.json bun.lock bunfig.toml ./

# Copy workspace package files (only the ones needed for Docker build)
COPY backend/package.json ./backend/
COPY packages/patient-picker/package.json ./packages/patient-picker/
COPY packages/auth/package.json ./packages/auth/
COPY packages/app-store/package.json ./packages/app-store/
COPY packages/elysia-mcp/package.json ./packages/elysia-mcp/

# Strip workspaces not included in Docker build to avoid install failures
RUN bun -e 'const p=JSON.parse(require("fs").readFileSync("./package.json","utf8")); p.workspaces=["backend","packages/auth","packages/app-store","packages/elysia-mcp","packages/patient-picker"]; require("fs").writeFileSync("./package.json", JSON.stringify(p,null,2))'

# Install dependencies for Docker-relevant workspaces only. The registry token comes
# in as a BuildKit secret so it never lands in an image layer; the retry loop and the
# fail-fast token check are shared with CI.
COPY scripts/bun-install.sh ./scripts/
RUN --mount=type=secret,id=gh_packages_token \
    GH_PACKAGES_TOKEN="$(cat /run/secrets/gh_packages_token 2>/dev/null || true)" \
    sh ./scripts/bun-install.sh

# Copy shared Vite config (imported by all SMART apps via ../../config/vite-config)
COPY config/ ./config/

# Backend build stage (just the JS bundle)
FROM build-deps AS backend-build
COPY packages/auth/ ./packages/auth/
COPY packages/app-store/ ./packages/app-store/
COPY packages/elysia-mcp/ ./packages/elysia-mcp/
COPY backend/ ./backend/
WORKDIR /app/backend
# NODE_ENV=production ensures the bundler preserves production-only code paths
# (e.g. CORS origins for production app domains) during dead-code elimination
ENV NODE_ENV=production
RUN bun run build

# OpenAPI spec generation (runs in parallel with backend-build)
# export-openapi imports TypeScript source directly, doesn't need dist/
FROM build-deps AS openapi-gen
COPY packages/auth/ ./packages/auth/
COPY packages/app-store/ ./packages/app-store/
COPY packages/elysia-mcp/ ./packages/elysia-mcp/
COPY backend/ ./backend/
WORKDIR /app/backend
RUN bun run export-openapi

# Patient Picker build stage
FROM build-deps AS patient-picker-build
COPY packages/patient-picker/ ./packages/patient-picker/
WORKDIR /app/packages/patient-picker
RUN bun run build

# Docs build stage (VitePress)
FROM build-deps AS docs-build
COPY docs/ ./docs/
RUN bun run docs:build

# Production stage — single backend serves everything
FROM base AS backend
WORKDIR /app

# The commit this image was built from, so the running server can name its own source for
# the AGPL offer without the repository carrying a stamped version.
ARG BUILD_SHA=""
ENV BUILD_SHA=$BUILD_SHA

# Install minimal runtime dependencies
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Amazon RDS CA bundle, for VERIFIED TLS to RDS Postgres.
#
# Needed because RDS certificates chain to "Amazon RDS <region> Root CA", which is
# not in the Mozilla root store that ca-certificates ships — so verification fails
# without it, and node-pg attempts no TLS at all by default. RDS Postgres 15+ sets
# rds.force_ssl=1, so an unencrypted connection is rejected outright with
# "no pg_hba.conf entry ... no encryption". lib/pg-pool.ts reads this path from
# PGSSLROOTCERT and fails loudly if it is set but unreadable.
#
# The global bundle covers every region (108 certs, including
# "Amazon RDS eu-central-1 Root CA RSA2048 G1" which matches this deployment's
# rds-ca-rsa2048-g1), so it needs no per-region variant and survives a CA rotation.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN chmod 0444 /etc/ssl/certs/rds-global-bundle.pem

# Copy built backend
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=backend-build /app/backend/package.json ./backend/package.json

# Copy backend's public directory (landing page, static assets)
COPY --from=backend-build /app/backend/public ./backend/public

# Admin UI, built by CI from proxy-smart/proxy-smart-admin-ui straight into
# webapp-dist/. Empty in a local build, which the /webapp route reports rather
# than failing on — the API and /mcp carry the same surface.
COPY webapp-dist/ ./backend/public/webapp

# Copy built SMART apps into backend public
COPY --from=patient-picker-build /app/packages/patient-picker/dist ./backend/public/patient-picker

# Verify no localhost URLs leaked into production bundles
RUN grep -rn 'localhost:8445' /app/backend/public/apps/ 2>/dev/null | head -5 || true
RUN if grep -rl 'localhost:8445' /app/backend/public/apps/ 2>/dev/null; then \
      echo "WARNING: Found hardcoded localhost:8445 in app bundles (non-fatal for now)"; \
    fi

# Copy built VitePress docs
COPY --from=docs-build /app/docs/.vitepress/dist ./backend/public/docs

# Copy raw markdown docs for the /docs API
COPY --from=docs-build /app/docs ./docs

# Copy root node_modules (monorepo structure)
COPY --from=backend-build /app/node_modules ./node_modules

# Copy workspace packages needed at runtime (resolved via node_modules symlinks)
COPY --from=backend-build /app/packages/auth ./packages/auth
COPY --from=backend-build /app/packages/app-store ./packages/app-store

# Copy seed data for first-run initialization
# mcp-endpoint.json comes from backend/data/, app-store-config from deploy/<env>/
COPY backend/data/ ./backend/data-seed/
ARG DEPLOY_ENV=prod
COPY deploy/${DEPLOY_ENV}/app-store-config.json ./backend/data-seed/app-store-config.json

# Create non-root user for security
RUN groupadd --gid 1001 app && \
    useradd --uid 1001 --gid app --no-create-home --shell /bin/false app && \
    mkdir -p /app/backend/data && \
    chown -R app:app /app

# Declare data volume so Docker initialises it with correct ownership (app:app)
VOLUME /app/backend/data

USER app

# Expose backend port
EXPOSE 8445

# Start the backend API server (serves API + all frontend apps)
WORKDIR /app/backend
CMD ["bun", "run", "dist/index.js"]
