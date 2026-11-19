# Build context is the repository root: docker build -f deploy/poc/caddy.Dockerfile .
FROM node:24-alpine AS web
RUN npm install --global pnpm@9.0.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @roadmap/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @roadmap/web build

FROM caddy:2-builder AS caddy
# golang.org/x/net is pinned past the version Caddy ships (CVE-2026-78661).
RUN xcaddy build --with github.com/mholt/caddy-ratelimit --replace golang.org/x/net=golang.org/x/net@v0.62.0

FROM caddy:2-alpine
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY deploy/poc/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /repo/apps/web/dist /srv/web
