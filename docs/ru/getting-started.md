# Локальная настройка

## Требования

- **Node.js 22** (CI использует Node 22), npm;
- **mkcert** — локальные HTTPS-сертификаты обязательны для разработки (сигнальный WebSocket работает по `wss://`, WebRTC требует secure context);
- **Rust-тулчейн** (`rustup`) — только если вы правите сам `packages/engine/core/` (у движкового crate нет собственного WASM-таргета — см. [core.md](core.md)). Для игры тулчейн здесь не нужен: WASM-бинарь приходит из сборки игры-плагина (её собственный репозиторий).

## Установка

```bash
git clone https://github.com/lgick/vimp.git
cd vimp
npm install
```

Репозиторий — npm workspaces: `packages/engine` (`@vimp/engine`,
движок-приложение) и `packages/auth` (`@vimp/auth`, центральный
auth-сервис). Корневые скрипты (`npm run dev`, `npm run build`)
проксируют в `@vimp/engine`.

**Для реальной игры нужен пакет игры-плагина** — этот репозиторий его
больше не собирает. Установите/подключите игру (например, `@vimp/tanks`,
собранную и опубликованную из отдельного репозитория `vimp-tanks`) в
`node_modules`; про её локальную сборку — см. getting-started того
репозитория (для разработки подходит `npm link` или локальная
`file:`/`path:`-зависимость). Движок никогда не импортирует игру
статически — она грузится динамически в рантайме по `GameManifest` (см.
[plugin-api.md](plugin-api.md)), граница закреплена правилом ESLint.

## HTTPS-сертификаты (один раз)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Пути к сертификатам заданы в `packages/engine/src/config/master.js` (`httpsOptions`). В production сертификаты не нужны — мастер работает по HTTP за Nginx (см. [deployment.md](deployment.md)).

## Запуск

```bash
npm run dev
```

Поднимается **мастер-сервер** на `https://localhost:3002` (лобби + сигналинг, [master.md](master.md)); ViteExpress отдаёт клиент рядом с Express-сервером, nodemon следит за `packages/engine/src/master`, `packages/engine/src/lib`, `packages/engine/src/config`.

Матч идёт через **браузерный хост** ([host.md](host.md)): в лобби «Создать сервер» поднимает Web Worker с Rust-ядром активной игры-плагина в текущей вкладке; остальные вкладки/машины заходят в комнату из списка серверов. Для этого нужна установленная/подключённая игра-плагин (см. «Установка» выше).

Остальные команды:

```bash
npm start              # production-запуск мастера (читает .env: VIMP_DOMAIN и др.)
npm run build          # прод-сборка (Vite bundle движка; игра-плагин поставляет свой dist/ сама)
npm run build:app      # сегодня то же самое, что npm run build (алиас)
npm run core:test      # Rust-тесты движкового crate (cargo test --workspace, только packages/engine/core)
npx eslint .           # линтер
npm test               # тесты (Vitest), одиночный прогон
npm run test:watch     # тесты в watch-режиме
npm run test:coverage  # покрытие
```

Переменные `.env` для production описаны в [configuration.md](configuration.md#переменные-окружения-env).

## Rust-тулчейн (packages/engine/core/)

Нужен только при правке самого движкового Rust-crate (`vimp-engine-core`,
без своего WASM-таргета — см. [core.md](core.md)):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
npm run core:test             # Rust-тесты
```

Сборка и тестирование собственного WASM-ядра игры (`wasm-pack`, таргет
`wasm32-unknown-unknown`) — забота репозитория игры, см. его собственные
доки по локальной настройке.

## Локальный мультиплеер

- Откройте несколько вкладок браузера — каждая станет отдельным игроком: одна создаёт сервер, остальные заходят из лобби.
- Боты и прочие внутриигровые команды зависят от активной игры-плагина (например, `/bot 5` для танков — см. игровой процесс в доках той игры).
- Debug-режима нет; при необходимости реализуется отдельно.

## Тесты

Стек: **Vitest** + happy-dom (клиентские тесты) + coverage-v8. Конфиг `vitest.config.js` делит прогон на три проекта:

- `engine-node` — `tests/master`, `tests/lib`, `tests/config`, `tests/host`, `packages/engine/tests/fixtures` (окружение node);
- `engine-client` — `tests/client` (окружение happy-dom);
- `auth` — `tests/auth` (центральный auth-сервис, `packages/auth/src`).

Тесты лежат в `tests/` и зеркалят структуру `packages/engine/src/`.
Интеграция host-фасада проверяется на **fake-core фикстуре**
(`packages/engine/tests/fixtures/miniGame/` — самостоятельная вторая пара
HostPlugin/ClientPlugin, без WASM), доказывающей, что движок и его мета
(Panel/Stat/RoundManager/CommandProcessor/…) работают с любой игрой, а не
только с конкретной — поэтому `npm test` здесь проходит без единого
собранного Rust-артефакта и вообще без установленной игры-плагина.
Правило проекта: **любое изменение кода завершается зелёными
`npx eslint .` и `npm test`**. Репозиторий игры (например, `vimp-tanks`)
гоняет свои тесты против реального WASM-ядра — см. его собственные доки.

CI (`.github/workflows/test.yml`) гоняет job'ы линтинга, Rust-тестов
движкового crate и Vitest-проектов выше — для тестирования этого
репозитория сборка WASM не требуется.

---

[Следующая: Архитектура →](architecture.md)
