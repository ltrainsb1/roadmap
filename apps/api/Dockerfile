# Build context is the repository root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
RUN npm install --global pnpm@9.0.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @roadmap/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @roadmap/api build
# Production dependencies only. The bundles leave every package external except @roadmap/shared,
# which is TypeScript source that esbuild compiles into them.
RUN pnpm --filter @roadmap/api deploy --prod /out

FROM node:24-alpine
ENV NODE_ENV=production
# The image only runs node: drop npm, npx and corepack, whose bundled packages carry their own CVEs.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
