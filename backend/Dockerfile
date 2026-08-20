FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ARG BACKEND_BUILD_SHA=local
LABEL org.opencontainers.image.revision="$BACKEND_BUILD_SHA"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core wget \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1

CMD ["node", "dist/main.js"]
