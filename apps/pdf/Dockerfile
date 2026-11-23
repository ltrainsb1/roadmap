# Build context is the repository root: docker build -f apps/pdf/Dockerfile .
# Debian, not Alpine: Playwright's Chromium builds and its --with-deps package list are for glibc distributions.
FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@9.0.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/pdf/package.json apps/pdf/
RUN pnpm install --frozen-lockfile --filter @roadmap/pdf...
COPY apps/pdf apps/pdf
# Production dependencies only. The service runs its TypeScript source with --experimental-strip-types: no bundle.
RUN pnpm --filter @roadmap/pdf deploy --prod /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# Browsers live outside any user's home, so the image's non-root user can read them and cannot change them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/pdf/src ./src
# Only Chromium's headless shell (what chromium.launch() runs in headless mode) and the system packages it needs,
# both from the playwright-core version in the lockfile, so the browser matches the library.
RUN node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /tmp/* \
  && chmod -R a+rX /ms-playwright
# The image only runs node: drop npm, npx and corepack, whose bundled packages carry their own CVEs.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
# A user of its own, apart from the node image's `node` user, as Playwright's Docker guidance suggests for a browser.
# Chromium writes its temporary profile under /tmp and a little under $HOME. A fixed uid and gid (10001), so the
# compose file can give the read-only container a tmpfs home this user owns.
RUN groupadd --system --gid 10001 pdf \
  && useradd --system --uid 10001 --gid pdf --create-home --home-dir /home/pdf pdf
USER pdf
EXPOSE 3200
CMD ["node", "--experimental-strip-types", "src/server.ts"]
