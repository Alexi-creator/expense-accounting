<h1 align="center">🍋 LimeBalance</h1>

<p align="center">
  <b>A personal finance tracker you control straight from Telegram.</b><br/>
  Log expenses and income in seconds, organize them into categories, and get instant multi-currency summaries — all backed by a clean, documented REST API.
</p>

<p align="center">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" />
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-black?logo=fastify&logoColor=white" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" />
  <img alt="grammY" src="https://img.shields.io/badge/grammY-Telegram%20Bot-26A5E4?logo=telegram&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" />
</p>

---

## ✨ Features

- **💬 Telegram-first UX** — add expenses and income through a conversational bot powered by [grammY](https://grammy.dev/). No app to install.
- **🗂️ Categories with emoji** — organize spending and earnings into custom, emoji-tagged categories.
- **🌍 Multi-currency** — every entry is stored in its original currency and normalized to USD for unified reporting. The default currency is even inferred from the user's timezone.
- **📊 Summaries & stats** — instant breakdowns of where your money goes.
- **🔐 Flexible auth** — email/password, **Google Sign-In**, and **Telegram login**, with JWT access tokens and HTTP-only cookie refresh tokens.
- **🪪 Plans & subscriptions** — tiered limits (categories / expenses / incomes) baked into the data model.
- **📚 Self-documenting API** — Swagger UI generated automatically in non-production environments.
- **🛡️ Hardened by default** — request validation (Zod + class-validator), rate limiting (`@nestjs/throttler`), and CORS allow-listing.

---

## 🧱 Tech Stack

| Layer            | Technology                                              |
| ---------------- | ------------------------------------------------------- |
| Runtime          | Bun + TypeScript                                        |
| Framework        | [NestJS 11](https://nestjs.com/) on [Fastify](https://fastify.dev/) |
| Telegram bot     | [grammY](https://grammy.dev/)                           |
| Database         | PostgreSQL via [Prisma 7](https://www.prisma.io/) ORM   |
| Auth             | Passport + JWT, Google & Telegram strategies, bcrypt    |
| Validation       | Zod (env) + class-validator / class-transformer (DTOs)  |
| Tooling          | [Biome](https://biomejs.dev/) (lint + format), Jest     |
| Delivery         | Docker, Docker Compose, GitHub Actions → GHCR → VPS     |

---

## 🏗️ Architecture

```
                    ┌──────────────┐     webhook      ┌─────────────────────────┐
   Telegram  ◄─────►│  Telegram     │ ───────────────► │   NestJS + Fastify API   │
   user            │  (grammY bot)  │                  │                          │
                    └──────────────┘                  │  ┌────────────────────┐  │
                                                       │  │  Auth (JWT/Google/ │  │
   Web / API ◄────────── REST + Swagger ──────────────┤  │       Telegram)    │  │
   clients                                             │  ├────────────────────┤  │
                                                       │  │ Expenses / Incomes │  │
                                                       │  │ Categories         │  │
                                                       │  │ Currency / Summary │  │
                                                       │  │ Users / Plans      │  │
                                                       │  └────────────────────┘  │
                                                       └────────────┬─────────────┘
                                                                    │ Prisma
                                                                    ▼
                                                            ┌───────────────┐
                                                            │  PostgreSQL   │
                                                            └───────────────┘
```

The codebase is organized into feature modules under [`src/modules/`](src/modules/) (`auth`, `expenses`, `incomes`, `expense-categories`, `income-categories`, `currency`, `transactions`, `users`), with the Telegram integration isolated in [`src/bot/`](src/bot/) and shared utilities in [`src/common/`](src/common/).

---

## 🚀 Getting Started

### Prerequisites

- [Docker](https://www.docker.com/) & Docker Compose
- A [Telegram bot token](https://core.telegram.org/bots#botfather) (from `@BotFather`)
- [ngrok](https://ngrok.com/) — Telegram webhooks require HTTPS, so ngrok tunnels your local server during development

### 1. Configure environment

Create a `.env` file in the project root:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@db:5432/limebalance

BOT_TOKEN=your-telegram-bot-token
WEBHOOK_URL=https://your-ngrok-subdomain.ngrok-free.app

CORS_ORIGIN=http://localhost:5173
GOOGLE_CLIENT_ID=your-google-client-id
JWT_SECRET=a-secret-of-at-least-32-characters
```

> Environment variables are validated at startup against [`src/config/env.schema.ts`](src/config/env.schema.ts) — the app refuses to boot with an invalid configuration.

### 2. Run in development

```bash
make dev
```

This spins up the database and app via Docker Compose and starts an ngrok tunnel. Then point Telegram at your webhook:

```bash
make set-webhook
```

### 3. Apply database migrations

```bash
make migrate                       # create & apply during development
make migrate-create name=add_x     # create a named migration
make migrate-deploy                # apply pending migrations (production)
make migrate-status                # check migration state
```

Inspect data visually with Prisma Studio:

```bash
make db-studio   # http://localhost:5555
```

---

## 🧑‍💻 Local (non-Docker) workflow

```bash
bun install

bun run start:dev      # watch mode, straight from src/
bun run start:prod     # run compiled build from dist/

bun run lint           # Biome checks
bun run lint:fix       # Biome auto-fix
bun run format         # Biome format
bun run typecheck      # TypeScript 7 (tsgo), types only

bun run test           # unit tests
bun run test:e2e       # end-to-end tests
bun run test:cov       # coverage
```

---

## 📖 API Documentation

With the app running in a non-production environment, interactive Swagger docs are available at:

```
http://localhost:3000/api/docs
```

All routes are served under the `/api` prefix. A few highlights from the auth module:

| Method | Endpoint              | Description                          |
| ------ | --------------------- | ------------------------------------ |
| POST   | `/api/auth/register`  | Register with email & password       |
| POST   | `/api/auth/login`     | Log in and receive tokens            |
| POST   | `/api/auth/google`    | Sign in with Google                  |
| POST   | `/api/auth/telegram`  | Sign in with Telegram                |
| POST   | `/api/auth/refresh`   | Rotate the access token              |
| GET    | `/api/auth/me`        | Get the current user                 |
| POST   | `/api/bot/webhook`    | Telegram webhook entry point         |

---

## 🚢 Deployment (CI/CD)

Pushing to the repository triggers the GitHub Actions workflow in [`.github/workflows/`](.github/):

```
push ──► GitHub Actions
           ├── Builder stage     → compile TS → dist/
           └── Production stage  → dist/ + prod node_modules → ~150MB image
                                        │
                                        ▼
                            ghcr.io/<owner>/limebalance:latest
                                        │
                                        ▼
                            VPS: docker pull → docker run
```

The production image carries only the compiled output and runtime dependencies — no build toolchain — keeping it small and fast to ship.

---

## 📂 Project Structure

```
src/
├── bot/                  # Telegram bot: controller, service, state & handlers
│   └── handlers/         # start, expense, income, category, stat
├── common/               # currency/timezone utilities, shared DTOs
├── config/               # Zod-validated environment schema
├── modules/
│   ├── auth/             # JWT, Google & Telegram strategies, guards, decorators
│   ├── expenses/         # & expense-categories
│   ├── incomes/          # & income-categories
│   ├── currency/         # conversion & summary helpers
│   ├── transactions/
│   └── users/
├── prisma/               # Prisma service
└── main.ts               # bootstrap, CORS, validation, Swagger
prisma/                   # schema & migrations
scripts/                  # operational scripts (e.g. db backup)
```

---

## 📝 License

This project is currently **private and unlicensed** (`UNLICENSED`).

<p align="center"><sub>Built with NestJS, Prisma &amp; grammY by Elijah Pavlov.</sub></p>
