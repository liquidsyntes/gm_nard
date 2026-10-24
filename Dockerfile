FROM node:22.23.2-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
RUN npm run build

FROM node:22.23.2-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4173 \
    GAME_BIND_HOST=0.0.0.0 \
    GAME_DATA_DIR=/app/data \
    GAME_LOG_DIR=/app/logs
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node

EXPOSE 4173
CMD ["node", "server.mjs"]
