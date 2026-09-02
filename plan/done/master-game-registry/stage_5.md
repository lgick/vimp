# Этап 5. Dedicated, деплой, чистка, документация ✅ выполнен

**Область:** `packages/engine/src/dedicated/`, корневой `package.json`,
`Dockerfile`, `.github/`, `scripts/release/`, `docs/en/`, `docs/ru/`,
`docs/ai/`, `packages/engine/CHANGELOG.md`.

**Цель:** движок окончательно перестаёт содержать игры — ни в зависимостях,
ни в образе, ни в переменных деплоя. Dedicated-сервер добывает свою игру сам.

## 5.1 Dedicated-сервер

`packages/engine/src/dedicated/main.js:106-127` сейчас требует, чтобы игра
была в `master:games`, и резолвит её в `node_modules`:

```js
const entry = games.find(game => game.id === gameId);
if (!entry && loadGame === loadGamePackage) throw new Error(
  `dedicated: game "${gameId}" is not listed in master:games — …`);
```

Новый порядок разрешения игры:

1. `VIMP_DEDICATED_GAME` разбирается как `<id>` или `<id>@<version>`
   (точная версия — пин; без неё берётся одобренная из реестра).
2. Игра есть в `master:games`/`node_modules` (dev, `npm link`) → прежний путь,
   ничего не качаем.
3. Иначе, если задан `VIMP_AUTH_SERVICE_URL`: `GameRegistryProxy.list()` →
   найти `id` → `GameStore.ensure(id, packageName, version)` → использовать
   полученный `distDir`.
4. Ни то, ни другое → **именованная ошибка** в прежнем стиле, перечисляющая
   оба способа:
   ```
   dedicated: game "<id>" is not available — link it into node_modules or
   set VIMP_AUTH_SERVICE_URL so the server can fetch it from the registry
   ```

Дальше без изменений: `loadGamePackage(distDir)` берёт `entries.wasmNode` →
`dist/core-node/` (`loadGamePackage.js:62-91`), `createHostRuntime` получает
живой `hostPlugin`.

`GameCatalog` в dedicated строится из одной записи — передать в него
скачанную версию тем же `upsert`, чтобы `/games/:id/:version/*` работал
одинаково с лобби-мастером.

**Dedicated-контейнеру нужен том** (см. §5.3) — он пишет в `VIMP_GAMES_DIR`.

## 5.2 Чистка «игры внутри движка»

| Файл | Что убрать / изменить |
| --- | --- |
| корневой `package.json` | удалить `@vimp-games/snakes` и `@vimp-games/tanks` из `dependencies`; обновить `package-lock.json` (`npm install`) |
| `Dockerfile:38-52` | удалить стейджинг `/app/game-dists` |
| `Dockerfile:84-88` | удалить `COPY … game-dists → node_modules/@vimp-games` |
| `Dockerfile:14-19` | переписать комментарий: `npm ci` больше не приносит игр |
| `packages/engine/src/config/master.js:36` | `games: []` (сделано на Этапе 3) |

`src/devtools` в prod-образ **не добавлять**: валидатор мастера
(`gamePackageCheck.js`) намеренно самостоятелен и не тянет `devtools/`.

## 5.3 Деплой

### `.github/workflows/deploy.yml`

- Job `prepare-matrix` (`:160-178`): убрать чтение `vars.GAMES_MATRIX` и
  выход `games`.
- Job `deploy` (`:203-223`): убрать `GAMES_MATRIX` из `env` и из списка
  `envs:` для `ssh-action`; добавить `VIMP_GAMES_DIR`.
- Генерация `.env.prod` (`:252-264`): убрать блок `GAMES_MATRIX`, добавить
  `VIMP_GAMES_DIR=/var/vimp/games`.
- Генерация `docker-compose.yml` (`:266-282`): добавить том и верхнеуровневый
  ключ `volumes`:

  ```yaml
  services:
    master:
      …
      volumes:
        - "vimp-games:/var/vimp/games"
  volumes:
    vimp-games:
  ```

  **Права.** Образ движка не объявляет `USER`, процесс идёт от root, и
  именованный том создаётся root-owned — записи хватит. Полагаться на это
  молча всё же нельзя: `GameStore` при старте делает
  `fs.mkdir(dir, { recursive: true })` и проверяет `W_OK`, а при отказе
  падает с именованной ошибкой, называющей путь и `VIMP_GAMES_DIR`
  (Этап 2, §2.4). Если образ когда-нибудь получит непривилегированного
  пользователя, ошибка будет читаемой, а не `EACCES` из середины скачивания.

- Job `deploy_auth` (`:95-155`): **обновлять `VIMP_ADMIN_NICKS` при каждом
  деплое** из `vars.VIMP_ADMIN_NICKS`. `.env.prod` auth-стека пишется
  один раз при провижининге (`add-server.sh:302-311`), а `env_file`
  читается только при создании контейнера — поэтому просто положить
  переменную мало. Нужно: идемпотентно переписать строку в `.env.prod`
  (`sed -i` по якорю или пересборка строки), затем
  `docker compose up -d --force-recreate auth`. Та же ловушка уже описана
  для `VIMP_AUTH_ALLOWED_ORIGINS` в `docs/en/deployment.md:295-300` — в
  документации сослаться на неё.

### `.github/deployment/add-server.sh`

В блок записи `.env.prod` auth-стека (`:302-311`) добавить
`VIMP_ADMIN_NICKS=` (пустое значение допустимо) и вопрос оператору о списке
админов при провижининге auth-домена.

### Переменные GitHub

- Удалить: `GAMES_MATRIX`.
- Добавить: `VIMP_ADMIN_NICKS`.
- Не трогать: `SERVERS_MATRIX`, `AUTH_SERVICE_URL`, `AUTH_SERVER_IP`.

### CSP — не трогать

Все игровые ассеты остаются на том же origin, что и мастер. Ни
`src/config/master.js:126-141`, ни шаблон nginx в `install-system.sh:392-404`,
ни сниппеты в `docs/{en,ru}/deployment.md` не меняются — иначе упадёт
`tests/config/csp-nginx-parity.test.js`. (Расширение CSP понадобится только
при будущем переходе на CDN.)

## 5.4 Скрипт релиза

`scripts/release/steps.js:630-633`, `rollOutProduction`:

```js
for (const game of games) {
  await shell.write('npm', ['i', `${game.name}@${game.target}`], { cwd: root });
}
```

Пинов в корневом `package.json` больше нет — этот цикл удалить. Вместо него
печатать напоминание:

```
прод: игры больше не пинятся в package.json — новую версию поднимает
разработчик в лобби («Мои игры» → «Обновить»), админ подтверждает в
«Модерации»
```

Коммит (`:648-652`) остаётся, но без `package.json`/`package-lock.json`, если
менялся только `PIN_SNAPSHOT`. Локальный `npm link` и `simGame` **не
трогать** — прогон симуляции по локальному чекауту остаётся частью релиза.

## 5.5 Документация

`docs/en/` — канон, `docs/ru/` — точное зеркало; правятся **в том же
изменении**.

| Страница | Что меняется |
| --- | --- |
| `master.md` | каталог строится из реестра auth, а не из `master:games`; `GameStore`/`GameSync`/`GameRegistryProxy` в таблице модулей; версионные роуты `/games/:id/:version/*` и алиасы; `mapsBase`; админские роуты; скрытые тестовые комнаты; `maxGameScore` теперь из реестра |
| `configuration.md` | `VIMP_GAMES_DIR`, блок `master:gameStore:*`; `master:games` по умолчанию пуст; `GAMES_MATRIX` — только dev/self-hosted |
| `auth.md` | роли (`users.role`, `VIMP_ADMIN_NICKS`), таблица `games`, миграция `009`, роуты `/games*` и `/admin/games*`, почему роль читается из БД, а не из клейма |
| `deployment.md` | `GAMES_MATRIX` больше не задаётся; том `vimp-games`; `VIMP_ADMIN_NICKS` и требование `--force-recreate auth`; раздел «Adding a second game» переписан на панель модерации |
| `dedicated.md` | разрешение игры (`<id>` / `<id>@<version>`), загрузка из реестра, требование тома |
| `publishing.md` | после публикации игры корневой пин не правится: версия поднимается через лобби |
| `plugin-api.md` | мастер переписывает `assetsBase`/`entries` в отдаваемом манифесте и добавляет `mapsBase`; `entries.wasmNode` не переписывается |
| `getting-started.md` | локальная разработка: `npm link` по-прежнему главный путь, реестр в dev игнорируется для прилинкованных игр |
| `docs/ai/02-packaging.md` | раздел «How the master serves it» — версионные URL, откуда берётся `packageVersion`, что мастер не исполняет код пакета |

`docs/ai/` — английский, вне билингвального правила, но правится тоже.

## 5.6 Changelog

`packages/engine/CHANGELOG.md`, секция `## [Unreleased]`. Крейт
(`packages/engine/core/CHANGELOG.md`) и `create-vimp-game` **не трогаются**.

```markdown
### ⚠️ Breaking

- Каталог игр движка пуст по умолчанию: список игр приезжает из реестра
  central auth-сервиса, а не из `master:games`/`GAMES_MATRIX`.
- URL игровых ассетов версионные (`/games/<id>/<version>/…`); мастер
  переписывает `assetsBase`/`entries` отдаваемого манифеста и добавляет
  `mapsBase`.
- `maps.manifestUrl`/`maps.baseUrl` в конфиге лобби принимают манифест, а не
  `gameId`.

### Migration

- Прогнать миграцию `009_games.sql` в auth-сервисе.
- Задать `VIMP_ADMIN_NICKS` (auth) и `VIMP_GAMES_DIR` (мастера), примонтировать
  том хранилища.
- Снять переменную `GAMES_MATRIX` — или оставить её, если мастер поднят без
  реестра: конфиг и авто-обнаружение `node_modules` продолжают работать.

### Added

- Роли пользователей и панель модерации игр в лобби.
- Реестр игр в auth-сервисе (`/games`, `/admin/games`).
- Хранилище игровых пакетов на мастере: загрузка из npm registry с проверкой
  целостности, структурная валидация без исполнения кода, синхронизация
  каталога на лету.
```

## 5.7 Обновление статусов плана

По завершении каждого этапа проставить «✅ выполнен» рядом с заголовком его
файла и в таблице `README.md`. После закрытия всех пяти —
`git mv plan/master-game-registry plan/done/master-game-registry` (перемещение
**не коммитить**).

## Критерии готовности этапа

1. `npx eslint . && npm test -- --silent` — зелено.
2. `grep -r "@vimp-games" package.json Dockerfile .github/workflows/` — ни
   одного вхождения (кроме комментариев про scope в `eslint.config.js` и
   `localGames.js`, которые остаются).
3. `docker build .` проходит; в образе нет `node_modules/@vimp-games`.
4. `VIMP_DEDICATED_GAME=tanks npm run dedicated` при пустом от игр
   `node_modules` — сервер качает игру сам и поднимает матч.
5. `npm run sim:check` — зелено.
6. `tests/config/csp-nginx-parity.test.js` — зелено (CSP не тронут).

## Сквозная проверка всего направления

1. Чистая БД: `npm run auth:db:migrate` дважды подряд — идемпотентно, в
   `games` две seed-строки.
2. `VIMP_ADMIN_NICKS=<свой ник> npm run dev:auth` + `npm run dev`. Вход →
   видны «Мои игры» и «Модерация».
3. **Локальный путь цел:** с `npm link`-нутыми `tanks` и `snakes` каталог
   собирается из `node_modules`, HMR исходников игры работает.
4. **Скачивание:** «Тест» на версии из npm → `.games/<id>/<version>/dist`,
   зелёный вердикт, игра в селекторе с «(тест)», комната не видна из вкладки
   без админского токена.
5. **Одобрение:** игра в `/games/manifest.json`, ассеты и карты по
   `/games/<id>/<version>/…`, матч играется.
6. **Отклонение:** статус и комментарий видны разработчику.
7. **Негативные:** несуществующий пакет; пакет без `dist/manifest.json`;
   манифест с чужим `id` — внятная ошибка, записи в auth нет, мастер жив.
8. **Смешанный кэш:** админ играет в черновик, затем заходит в комнату на
   одобренной версии — грузится плагин одобренной версии.
9. **Отказ auth:** мастер продолжает раздавать уже скачанный каталог.
10. Ручной браузерный смоук: два окна, комната, звук, карта, смена версии
    игры при живой комнате (эстафета Worker'ов по `codeVersion`).
