# ---- build ----
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: one image, two roles (api = dist/main.js, worker = dist/worker.js) ----
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prisma ./prisma
COPY data ./data
COPY scripts/docker-start.sh ./docker-start.sh
EXPOSE 3000
# Default: API (optionally migrate first / run workers in-process, see docker-start.sh).
# docker-compose overrides the command per service.
CMD ["sh", "./docker-start.sh"]
