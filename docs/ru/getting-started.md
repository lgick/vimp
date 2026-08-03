# Локальная настройка

## Требования

- **Node.js 24** (CI использует Node 24), npm;
- **mkcert** — локальные HTTPS-сертификаты обязательны для разработки (сигнальный WebSocket работает по `wss://`, WebRTC требует secure context);
- **PostgreSQL** — нужен центральному auth-сервису, а вход в лобби закрыт логин-гейтом, поэтому нужен и для локальной игры (см. [Центральный auth-сервис](#центральный-auth-сервис-нужен-для-входа-в-лобби));
- **Rust-тулчейн** (`rustup`) — только если вы правите сам `packages/engine/core/` (у движкового crate нет собственного WASM-таргета — см. [core.md](core.md)). Для игры тулчейн здесь не нужен: WASM-бинарь приходит из сборки игры-плагина (её собственный репозиторий).

## Установка

```bash
git clone https://github.com/lgick/vimp.git
cd vimp
npm install
```

Репозиторий — npm workspaces: `packages/engine` (`vimp-engine`,
движок-приложение) и `packages/auth` (`@vimp/auth`, центральный
auth-сервис). Корневые скрипты (`npm run dev`, `npm run build`)
проксируют в `vimp-engine`.

**Для реальной игры нужен пакет игры-плагина** — этот репозиторий его
больше не собирает. Установите/подключите игру (например, `@vimp-games/tanks`,
собранную и опубликованную из отдельного репозитория `vimp-tanks`) в
`node_modules`. Движок никогда не импортирует игру статически — она грузится
динамически в рантайме по `GameManifest` (см.
[plugin-api.md](plugin-api.md)), граница закреплена правилом ESLint.

Для повседневной разработки вместо установки из registry подключите
локальный чекаут игры — см. следующий раздел.

## Подключение локального чекаута игры-плагина

Установки из registry для разработки недостаточно: в опубликованном тарболе
лежит только `dist/` (`files: ["dist"]`), тогда как в dev `GameCatalog`
подменяет `entries` манифеста на Vite-URL `/@fs/`, указывающие на `src/` и
`core/pkg-web/*.wasm` пакета (исходники плагина получают HMR наравне с
остальным движком). С registry-копией эти entries указывают на
несуществующие файлы. Свяжите пакеты друг с другом:

```bash
cd vimp-tanks && npm link              # регистрирует @vimp-games/tanks глобально
cd vimp/packages/engine && npm link    # регистрирует vimp-engine глобально

cd vimp && npm link @vimp-games/tanks  # движок ← плагин
cd vimp-tanks && npm link vimp-engine  # плагин ← движок
```

Важны оба направления:

- **движок ← плагин** — dev-entries `/@fs/` резолвятся в чекаут, поэтому
  правки клиентского/хостового кода плагина вообще не требуют пересборки;
- **плагин ← движок** — импорты `vimp-engine/*` из плагина (например,
  `vimp-engine/lib/math.js`) резолвятся в исходники самого движка, которые
  Vite переписывает в `/src/lib/math.js`. Обе половины получают один
  экземпляр модулей и один `ENGINE_API_VERSION`; registry-копия внутри
  `node_modules` плагина была бы вторым, молча разъезжающимся экземпляром.

С `pixi.js` дополнительных действий не нужно: Vite резолвит bare-специфер
`pixi.js` из плагина в ту же оптимизированную зависимость, что и у движка
(`node_modules/.vite/deps/pixi__js.js`), поэтому требование единственного
экземпляра (см. [client.md](client.md)) выполняется и в dev.

`npm install` в любом из репозиториев заменяет симлинки registry-копиями —
после установки повторите две команды `npm link <имя>`. Проверка:

```bash
readlink node_modules/@vimp-games/tanks   # в движке → ../../../vimp-tanks
readlink node_modules/vimp-engine          # в плагине → ../../vimp/packages/engine
```

Плагин также должен быть хотя бы раз собран до первого запуска
(`npm run core:build && npm run build` в его репозитории): даже в dev мастер
читает `dist/manifest.json` и `dist/maps/*.json` и раздаёт `dist/sounds/**`
по `/games/<id>/`.

## HTTPS-сертификаты (один раз)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Пути к сертификатам заданы в `packages/engine/src/config/master.js` (`httpsOptions`). В production сертификаты не нужны — мастер работает по HTTP за Nginx (см. [deployment.md](deployment.md)).

## Центральный auth-сервис (нужен для входа в лобби)

Лобби закрыто логин-гейтом **LobbyAuth** — анонимного входа нет, поэтому для
локального матча нужен запущенный `packages/auth` с базой, парой ключей RS256
и GitHub OAuth App:

```bash
brew services start postgresql@16   # или любой локальный PostgreSQL
createdb vimp_auth

mkdir -p .keys
openssl genrsa -out .keys/jwt.pem 2048
openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem

npm run auth:db:migrate
```

Заведите GitHub OAuth App (Homepage `https://localhost:3002`, callback
`http://localhost:3010/oauth/github/callback`) и положите его креды в `.env`
в корне репозитория — файл в `.gitignore`, его читает `npm run dev:auth`:

```
VIMP_AUTH_DATABASE_URL=postgres://localhost:5432/vimp_auth
VIMP_AUTH_STATE_SECRET=<openssl rand -hex 32>
VIMP_AUTH_GITHUB_CLIENT_ID=...
VIMP_AUTH_GITHUB_CLIENT_SECRET=...
```

Остальное у сервиса имеет dev-дефолты (`port: 3010`,
`allowedOrigins: ['https://localhost:3002']`) — см. [auth.md](auth.md).

### Вход без OAuth (только dev)

Вне прода сервис поднимает ещё и `GET /dev/login`: выдаёт identity-токен на
произвольный ник и редиректит с ним в лобби — та же передача через `?token=`,
что делает OAuth-колбэк, поэтому на клиенте ничего не отличается:

```
http://localhost:3010/dev/login?nick=Player1&returnUrl=https://localhost:3002/
```

Держите по такой закладке на профиль браузера (identity-токен лежит в
`localStorage`, а он у каждого профиля свой) — это самый быстрый способ
получить несколько настоящих игроков на одной машине. Повторный вход тем же
ником переиспользует ту же строку пользователя, поэтому rank и state
копятся как у настоящего аккаунта.

Маршрут регистрируется только при `NODE_ENV !== 'production'` (в проде —
`404`), а ссылка печатается в стартовом баннере сервиса. Это ускоритель, а не
замена: реальный GitHub-путь стоит хотя бы раз пройти перед выкладкой всего,
что касается логина.

## Запуск

```bash
npm run dev:auth   # терминал 1 — auth-сервис, http://localhost:3010
npm run dev        # терминал 2 — мастер-сервер, https://localhost:3002
```

`npm run dev` поднимает **мастер-сервер** (лобби + сигналинг, [master.md](master.md)); ViteExpress отдаёт клиент рядом с Express-сервером, nodemon следит за `packages/engine/src/master`, `packages/engine/src/lib`, `packages/engine/src/config`.

В стартовом баннере обязана быть строка с игрой:

```
-> Games loaded: tanks
```

`none` означает, что плагин не слинкован, не собран или его
`manifest.engineApi` разошёлся с `ENGINE_API_VERSION` этой сборки —
`GameCatalog` пропускает такую игру с `console.warn`, и в лобби не остаётся
ни одной игры.

Матч идёт через **браузерный хост** ([host.md](host.md)): в лобби «Создать сервер» поднимает Web Worker с Rust-ядром активной игры-плагина в текущей вкладке; остальные вкладки/машины заходят в комнату из списка серверов.

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

## Цикл разработки

Правки движка не требуют ничего: nodemon перезапускает мастер на
`src/master`/`src/lib`/`src/config`, клиент подхватывает Vite HMR. Цена
правки **игры-плагина** зависит от того, что вы тронули — манифест, карты и
звуки мастер читает из `dist/` плагина один раз на старте, отсюда рестарты:

| Что правите в плагине | Что запустить |
| --- | --- |
| JS клиента/хоста (`src/**`) | ничего — HMR / перезагрузка вкладки |
| его Rust-ядро | `npm run core:build:web` (плюс `:node` перед его тестами), перезагрузить вкладку |
| карты | `npm run build:assets`, рестарт мастера |
| `roomForm`/`roomDefaults`/поля манифеста | `npm run build:manifest`, рестарт мастера |
| звуки | `npm run audio:process` (нужен ffmpeg), затем `npm run build:assets` |

Definition of done — в **каждом** репозитории: зелёные `npx eslint .` и
`npm test`; правки движения в ядре дополнительно требуют
`npm run core:test` (cargo-сьют parity предиктора и реплики). Изменение
публичной поверхности `exports` движка (`lib/*`, `config/*`, `host/*`) ломает
плагины, чей CI ставит `vimp-engine` из registry — такие изменения выходят
через bump версии и публикацию, а не через локальный линк.

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
- Identity-токен лежит в `localStorage`, поэтому все вкладки одного профиля браузера — **один и тот же** игрок (один ник). Для действительно разных игроков нужны отдельные профили/окна браузера; чтобы просто наполнить комнату, проще боты.
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
