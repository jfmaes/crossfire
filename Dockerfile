FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/storage/package.json packages/storage/
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/ apps/

# Build daemon (TypeScript -> JS) and web (Vite bundle)
RUN pnpm build

# -------------------------------------------------------------------
# Production image
# -------------------------------------------------------------------
FROM node:20-slim AS production
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# Install claude and codex CLIs (npm global)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Copy built artifacts and node_modules from build stage
COPY --from=base /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/daemon/dist ./apps/daemon/dist
COPY --from=base /app/apps/daemon/package.json ./apps/daemon/
COPY --from=base /app/apps/daemon/node_modules ./apps/daemon/node_modules
COPY --from=base /app/apps/web/dist ./apps/web/dist

# The daemon serves the API; a static file server serves the web build.
# In production, put a reverse proxy in front (see docker-compose.yml).
EXPOSE 8787

# Runtime data directory
VOLUME /app/data

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

# Run the daemon with tsx (needed for TypeScript ESM imports in workspace packages)
CMD ["npx", "tsx", "apps/daemon/src/main.ts"]
