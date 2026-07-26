# ============================================================
# 1. BUILDER — сборка движка
# ============================================================

FROM node:24-slim AS builder

WORKDIR /app

# копирование package.json (включая манифест пакета движка),
# чтобы установить зависимости
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/

# установка зависимостей: npm ci ставит игровые пакеты-плагины (объявлены в
# корневом package.json, по списку `master:games`/GAMES_MATRIX — не в
# packages/engine, движок остаётся game-agnostic, кодревью Этапов A,
# находка F1) из registry — приносит их уже собранный dist/ (манифест +
# бандлы + карты + звуки), движок больше не собирает WASM игры сам
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

# стейджинг dist/ всех установленных игровых пакетов-плагинов (любой
# @vimp-games/* в node_modules — отдельный scope от движковых
# workspace-пакетов @vimp/engine, @vimp/auth) — без хардкода конкретной игры,
# чтобы деплой не переписывать при добавлении второй игры в master:games
# (кодревью Этапов A, находка F6)
RUN mkdir -p /app/game-dists && \
    if [ -d node_modules/@vimp-games ]; then \
      for pkg_dir in node_modules/@vimp-games/*/; do \
        pkg_name=$(basename "$pkg_dir"); \
        if [ -d "${pkg_dir}dist" ]; then \
          mkdir -p "/app/game-dists/@vimp-games/${pkg_name}"; \
          cp -r "${pkg_dir}dist" "/app/game-dists/@vimp-games/${pkg_name}/dist"; \
        fi; \
      done; \
    fi

# ============================================================
# 2. RUNNER — Production Image
# ============================================================

FROM node:24-slim AS runner

WORKDIR /app

# зависимости: манифест пакета движка нужен npm ci для симлинков @vimp/*
COPY package.json package-lock.json* ./
COPY packages/engine/package.json ./packages/engine/

RUN npm ci --omit=dev

# фронтенд движка (vite build; public копируется Vite внутрь dist)
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/public ./packages/engine/public

# мастер-сервер движка (лобби + сигналинг WebRTC + каталоги)
COPY --from=builder /app/packages/engine/src/config ./packages/engine/src/config
COPY --from=builder /app/packages/engine/src/lib ./packages/engine/src/lib
COPY --from=builder /app/packages/engine/src/master ./packages/engine/src/master

# собранные бандлы игр-плагинов, поставленных как npm-зависимости (мастер
# читает только dist/manifest.json + dist/maps/*.json через GameCatalog) —
# все @vimp-games/* из /app/game-dists, без хардкода конкретной игры
# (находка F6)
COPY --from=builder /app/game-dists/@vimp-games ./node_modules/@vimp-games

ENV NODE_ENV=production

# запуск мастер-сервера (cwd — пакет движка: dist/assets для WorkerCatalog,
# ../../node_modules/@vimp/<id> — для GameCatalog)
WORKDIR /app/packages/engine

CMD ["node", "src/master/main.js"]
