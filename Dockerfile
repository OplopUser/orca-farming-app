# --- Build stage ---
FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/

RUN npm run build

# --- Production stage ---
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY public/ public/

ENV NODE_ENV=production

EXPOSE 8787

CMD ["node", "dist/src/index.js", "run"]
