# Этап 5: Деплой, CI, конфигурация, документация

_Цель: dedicated-сервер деплоится тем же пайплайном, что и лобби-мастер, а
новые режимы описаны в конфигурации и доках._

## Задача 5.1: `Dockerfile` — runner-стадия

Сейчас в образ попадают только `src/config`, `src/lib`, `src/master`
(+ `dist`, `public`, `game-dists`). Для dedicated добавить:

```dockerfile
COPY --from=builder /app/packages/engine/src/host ./packages/engine/src/host
COPY --from=builder /app/packages/engine/src/dedicated ./packages/engine/src/dedicated
```

- `src/client` в образ **не** копируем: браузеру отдаётся собранный
  `packages/engine/dist`.
- `npm ci --omit=dev` в runner-стадии теперь притащит `howler` (переехал в
  `dependencies` на Этапе 3) — проверить, что образ собирается и не вырос
  критично.
- Node-ядро игры (`dist/core-node/`) уже попадает в образ вместе с
  `game-dists` — убедиться на конкретной игре, что каталог опубликован
  (иначе `loadGamePackage` упадёт с внятной ошибкой).

## Задача 5.2: `.github/workflows/deploy.yml`

Матрица серверов (`vars.SERVERS_MATRIX`) сегодня несёт `domain`, `port`, `ip`.
Добавить необязательное поле `dedicatedGame`:

```yaml
        env:
          # ...существующее
          VIMP_DEDICATED_GAME: ${{ matrix.dedicatedGame }}
        with:
          envs: IMAGE_NAME,VIMP_DOMAIN,VIMP_PORT,VIMP_AUTH_SERVICE_URL,GAMES_MATRIX,VIMP_DEDICATED_GAME,GITHUB_ACTOR,GITHUB_TOKEN
```

и в heredoc генерации `.env.prod`:

```bash
              if [ -n "$VIMP_DEDICATED_GAME" ]; then
                echo "VIMP_DEDICATED_GAME=$VIMP_DEDICATED_GAME"
              fi
```

Важно: имена, не перечисленные в `envs:`, `appleboy/ssh-action` не пробрасывает
— пропуск строки означает молчаливый запуск в лобби-режиме.

Nginx менять не нужно: `location /` уже проксирует upgrade-заголовки, поэтому
`/game` доходит до `ws`. CSP тоже не меняется (`connect-src 'self' wss:`,
sha256 inline-importmap'а не затрагивается) — но
`tests/config/csp-nginx-parity.test.js` должен остаться зелёным, это и есть
проверка.

## Задача 5.3: npm-скрипты и env

- `packages/engine/package.json` → `"dedicated": "NODE_ENV=development nodemon src/master/main.js -w src/master -w src/dedicated -w src/host -w src/lib -w src/config"`;
  корневой `package.json` → `"dedicated": "npm -w vimp-engine run dedicated"`.
- Новые env-переменные:
  | Переменная | Смысл |
  | --- | --- |
  | `VIMP_DEDICATED_GAME` | id игры; задана → процесс стартует dedicated-сервером |
  | `VIMP_DEDICATED_ROOM` | JSON-переопределения комнаты (`map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`) |
- Локальный запуск требует установленного/связанного пакета игры с
  `dist/` и `dist/core-node/` (как `npm run sim`).

## Задача 5.4: документация (en + ru попарно)

| Страница | Что добавить |
| --- | --- |
| `standalone.md` (новая, Этап 3) | SDK для репозитория игры |
| `dedicated.md` (новая, Этап 4) | Node-сервер: схема, env, ограничения |
| `README.md` | две новые строки в таблице + «Where to start» |
| `configuration.md` | `VIMP_DEDICATED_GAME`, `VIMP_DEDICATED_ROOM`, вынос чтения env из `isProduction` |
| `deployment.md` | как поднять dedicated-бокс (поле `dedicatedGame` в `SERVERS_MATRIX`), что деплой рвёт матч (эстафеты нет) |
| `getting-started.md` | локальные запуски: лобби, dedicated, ссылка на standalone |
| `master.md` | развилка точки входа, `GET /config` |
| `host.md` | порт-машина как модуль, стратегии идентичности (Этап 1) |
| `client.md` | режимы загрузки, `gameShell`, inline-хост (Этап 2) |
| `network.md` | `WebSocketTransport`, что происходит с meta/state и RTT |
| `publishing.md` | новая публикуемая поверхность, `howler` в `dependencies` |
| `plugin-api.md` | `entries.wasmNode` теперь нужен не только `npm run sim`, но и dedicated-серверу |
| `docs/ai/` | локальный прогон игры через SDK (английский, вне билингвы) |
| `CLAUDE.md` | строки таблицы `src/standalone/`, `src/dedicated/`; третья точка входа в «Architecture» |

## Задача 5.5: `packages/engine/CHANGELOG.md`

Одна запись `### Added` на всё направление (minor npm `vimp-engine`):
экспорты `./standalone`, `./client/*`, `./style.css`; `PortMachine` +
стратегии идентичности; `offlinePlayerData`; `HostGame.destroy()`;
`WebSocketTransport`; dedicated-сервер и `VIMP_DEDICATED_GAME`.
Крейт `vimp-engine-core` не затрагивается; `ENGINE_API_VERSION` не меняется.
Версию **не** править — публикует разработчик через `npm run release`.

## Проверка

```bash
npx eslint . && npm test
npm run build:app                     # прод-бандл собирается, postbuild-хэш CSP совпал
docker build -t vimp-test .           # runner-стадия видит src/host и src/dedicated
```
