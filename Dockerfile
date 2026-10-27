# Single image: builds the web app, then serves web + API from one Node process on $PORT.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
# Dev dependencies are needed to build the SPA and to run the TypeScript server through tsx.
RUN npm ci --include=dev

COPY . .
RUN npm run build

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:${PORT:-4000}/health || exit 1
CMD ["node", "scripts/start.mjs"]
