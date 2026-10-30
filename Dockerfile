FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && mkdir -p /app/.data && chown -R node:node /app
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/start.mjs ./scripts/start.mjs
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4317 4320
CMD ["node", "scripts/start.mjs"]
