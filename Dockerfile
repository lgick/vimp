# ============================================================
# 1. BUILDER — сборка движка
# ============================================================

FROM node:24-slim AS builder

WORKDIR /app

# копирование package.json (включая манифест пакета движка),
# чтобы установить зависимости
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/

# установка зависимостей движка. Игровых пакетов здесь больше нет вовсе
# (master-game-registry, этап 5): каталог игр приезжает из реестра
# auth-сервиса, а сами пакеты мастер качает из npm registry в рантайме и
# кладёт на смонтированный том (VIMP_GAMES_DIR) — образ остаётся
# game-agnostic и не пересобирается ради новой игры или её версии
RUN npm ci

# копирование проекта
COPY . .

# переменная окружения для Vite
ENV NODE_ENV=production

# домен central auth-сервиса, подставляемый Vite'ом в клиентский бандл
# (packages/engine/src/config/authClient.js:serviceUrl) — тот же central
# auth-сервис для всех мастеров, поэтому один build-arg на общий образ;
# сервер использует свою копию через VIMP_AUTH_SERVICE_URL (main.js),
# заданную отдельно в .env.prod каждого мастера при деплое
ARG VITE_AUTH_SERVICE_URL
ENV VITE_AUTH_SERVICE_URL=${VITE_AUTH_SERVICE_URL}

# сборка движка (vite build → packages/engine/dist/)
RUN npm run build:app

# ============================================================
# 2. RUNNER — Production Image
# ============================================================

FROM node:24-slim AS runner

WORKDIR /app

# зависимости: манифест пакета движка нужен npm ci для симлинков @vimp/*
COPY package.json package-lock.json* ./
COPY packages/engine/package.json ./packages/engine/

RUN npm ci --omit=dev

# фронтенд движка (vite build; public копируется Vite внутрь dist).
# Сырой public/ в рантайме не нужен: vite-express раздаёт статику строго из
# build.outDir и в publicDir не заглядывает
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist

# мастер-сервер движка (лобби + сигналинг WebRTC + каталоги)
COPY --from=builder /app/packages/engine/src/config ./packages/engine/src/config
COPY --from=builder /app/packages/engine/src/lib ./packages/engine/src/lib
COPY --from=builder /app/packages/engine/src/master ./packages/engine/src/master

# dedicated-режим той же точки входа (VIMP_DEDICATED_GAME): авторитетный матч
# крутится в процессе Node, поэтому образу нужен и хост.
# src/client в образ не копируется — браузеру отдаётся собранный dist
COPY --from=builder /app/packages/engine/src/host ./packages/engine/src/host
COPY --from=builder /app/packages/engine/src/dedicated ./packages/engine/src/dedicated

ENV NODE_ENV=production

# запуск мастер-сервера (cwd — пакет движка: dist/assets для WorkerCatalog).
# Игры лежат не в образе, а в хранилище на томе (VIMP_GAMES_DIR)
WORKDIR /app/packages/engine

CMD ["node", "src/master/main.js"]
