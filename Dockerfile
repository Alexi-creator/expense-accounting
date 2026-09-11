# ============================================
# Stage 1: Builder
# ============================================
FROM oven/bun:1.4-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN bunx prisma generate && bun run build
# The production stage starts `bun dist/main.js`, so a build that puts the entrypoint anywhere
# else must fail here rather than produce an image that crash-loops on the server.
RUN test -f dist/main.js

# ============================================
# Stage 2: Development
# ============================================
FROM oven/bun:1.4-alpine AS development

WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma

RUN bun install --frozen-lockfile && bunx prisma generate

COPY . .

CMD ["bun", "run", "start:dev"]

# ============================================
# Stage 3: Production
# ============================================
FROM oven/bun:1.4-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN bun install --production --frozen-lockfile && bunx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["bun", "dist/main.js"]
