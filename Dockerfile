# Use ECR Public Node.js image (Docker Hub is blocked in government environments)
FROM public.ecr.aws/docker/library/node:20-slim AS base

WORKDIR /app

# Disable SSL strict mode for government VPN environments (MUST be before any npm commands)
RUN npm config set strict-ssl false

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate && pnpm config set strict-ssl false

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN rm -rf api/dist shared/dist web/dist && pnpm build

FROM base AS runtime

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/web/dist ./web/dist

# Expose port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV PORT=3000
ENV LOAD_SSM=false
ENV WEB_DIST_DIR=/app/web/dist

# Start the application (run migrations first to ensure schema exists)
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
