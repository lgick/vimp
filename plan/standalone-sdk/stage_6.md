# Этап 6: Доработки в репозитории игры (`vimp-tanks`) ✅ выполнен

_Цель: `npm run dev` в `vimp-tanks` открывает браузер с матчем против ботов —
без клонирования движка, без мастера и без OAuth. Сборка плагина
(`npm run build`) не меняется._

Выполняется **в репозитории `vimp-tanks`** после Этапа 3 (движок опубликован
новой minor-версией или связан `npm link`). Предварительное ТЗ игры —
`~/Sites/my/vimp-tanks/plan/plan.md`; его нужно переписать под фактическую
сигнатуру SDK (там `bots: 5`, `hostPlugin` в Worker, `<link>` на
`node_modules/vimp-engine/src/client/style.css` — всё это заменяется).

## Что уже есть (не переделывать)

- `src/host/index.js` и `src/client/index.js` — готовые `HostPlugin`/`ClientPlugin`
  (default export), их и передаём в SDK живыми объектами.
- `core/pkg-web/vimp_tanks_core_bg.wasm` — web-сборка ядра
  (`npm run core:build:web`).
- `vimp-engine` уже в `devDependencies` (`^0.7.2` → поднять до новой minor),
  `pixi.js` — `peerDependencies` + `devDependencies`.
- Карты приезжают из `hostPlugin.gameConfig.maps` (бандл плагина), мастер для
  них не нужен — **проверить на первом прогоне**.

## Задача 6.1: `index.html` (новый, корень)

Минимальный каркас: `<div id="game">` + `<script type="module" src="/src/standalone.js">`.
CSS не подключаем тегами — их импортирует точка входа (Vite соберёт).
Инлайновые стили из `packages/engine/index.html` не копируем: после Этапа 2.2
они живут в `vimp-engine/style.css`.

`#game` обязан быть полноэкранным и позиционированным
(`position: relative; width: 100%; height: 100%`): в него монтируются и
каркас интерфейса, и канвасы, а `#panel`/`#stat`/`#vote` в движковом CSS —
`position: absolute`.

`display` контейнеру задавать не требуется на любой глубине вложенности:
правило скрытия экранов целится в сам контейнер (`.vimp-shell > *`, класс
ставит `ensureGameShell`), а не в первый уровень `body` — см. P1-1 в
[review.md](review.md) и R2-1 в [review-2.md](review-2.md). Учтите обратную
сторону: `style.css` — таблица уровня страницы, поэтому фон, шрифт и
`html, body { width/height: 100% }` движка достаются и странице.

## Задача 6.2: `src/standalone.js` (новый)

```js
import 'vimp-engine/style.css';
import './client/tanks.css';
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from './host/index.js';
import clientPlugin from './client/index.js';
import wasmUrl from '../core/pkg-web/vimp_tanks_core_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'),
  // звуки в dev лежат в build/sounds (продукт npm run audio:process);
  // SDK читает их как `${assetsBase}sounds/`
  assetsBase: '/build/',
  playerName: localStorage.getItem('vimp_dev_nick') || 'Tanker',
  playerModel: 'm1',
  // сначала выйти из наблюдателей, только потом просить ботов
  startupVotes: [['teamChange', 'team1']],
  startupCommands: ['/bot 4'],
  room: { map: 'pool mini' },
  devMode: true,
});
```

Про ботов (проверено по `src/host/botCommand.js`):

- синтаксис — `/bot <count> [team]`, то есть **одна** команда `'/bot 4'`, а не
  четыре `'/bot'`;
- handler первым делом отбивает команду наблюдателю
  (`user.teamId === ctx.spectatorId` → `BOT_PLAYERS_ONLY`), а новый участник
  входит наблюдателем — поэтому `startupVotes: [['teamChange','team1']]`
  обязателен и должен уйти раньше (движковый `initialVote: 'teamChange'`,
  `src/config/game.js:33`; команды — `team1`/`team2`, `game.js:134-138`);
- без голосования команда исполняется только при `activePlayerCount <= 1` —
  в solo это выполняется, вызывается `roundManager.initiateNewRound()`
  (раунд перезапускается, игрок респавнится);
- 4 бота + игрок должны влезать в `roomDefaults.maxPlayers`.

## Задача 6.3: `vite.config.js` — добавить режим `serve`

Текущий конфиг бросает исключение на любом `--mode`, кроме `client`/`host`.
Ввести ветку до этой проверки:

```js
export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    return {
      server: { open: true },
      resolve: { dedupe: ['pixi.js'] },   // один экземпляр PixiJS на страницу
      optimizeDeps: { exclude: ['vimp-engine'] }, // исходники движка не пре-бандлить
    };
  }
  // ...существующая сборка плагина без изменений
});
```

- `resolve.dedupe` обязателен: два экземпляра PixiJS = два реестра
  расширений и падение рендера. Дополнительно выровнять версию `pixi.js` в
  `devDependencies` с той, что закреплена в `vimp-engine`
  (сейчас `^8.14.0` против `8.19.0` в движке) — иначе npm вложит вторую копию
  в `node_modules/vimp-engine/node_modules/`.
- **Поправка по факту**: одного `exclude` мало. Исключённый из пре-бандла
  движок тянет свои npm-зависимости исходниками, а CJS в браузере не
  резолвится — вкладка падала на `eventemitter3` (внутри `pixi.js`), затем
  на `howler`. Рабочая комбинация:
  `optimizeDeps: { exclude: ['vimp-engine'], include: ['pixi.js', 'pixi.js/unsafe-eval', 'howler'] }`
  (`pixi.js/unsafe-eval` — отдельный вход `main.js` движка; общие чанки
  пре-бандла держат экземпляр PixiJS единственным).
- При работе через `npm link` добавить `server.fs.allow` с путём до чекаута
  движка (Vite не отдаёт файлы вне корня по умолчанию).
- **Звуки правок конфига не требуют** (проверено): `npm run audio:process`
  кладёт `.webm`/`.mp3` в `build/sounds/` (в `dist/sounds/` их копирует
  `scripts/copy-game-sounds.js`, то есть `npm run build:assets`), а Vite dev
  отдаёт любые файлы внутри корня проекта — `/build/sounds/…` и
  `/dist/sounds/…` доступны как есть; `.gitignore` доступу не мешает, а
  `server.fs.allow` нужен только для путей **вне** корня. Достаточно
  `assetsBase: '/build/'` (или `'/dist/'` после `build:assets`).
  `publicDir: 'dist'` использовать **не** стоит: это опция корневого уровня
  (не `server.publicDir`), и она совпадает с `build.outDir: 'dist'` — лишний
  риск в сборочной ветке ради того, что и так работает.

## Задача 6.4: `package.json`

- `"dev": "vite"`;
- `vimp-engine` → новая minor-версия;
- `pixi.js` в `devDependencies` → версия движка (см. выше);
- `files` не меняется (публикуется только `dist/`), `index.html` и
  `src/standalone.js` в пакет не попадают — проверяется `npm run check:pack`.

## Задача 6.5: документация игры

- `docs/en/getting-started.md` + `docs/ru/…`: `npm run core:build` →
  `npm run audio:process` (для звуков) → `npm run dev`; раздел про
  `npm link` оставить как альтернативу для разработки самого движка.
- `CHANGELOG.md` игры: `### Added` (локальный автономный запуск).
- `CLAUDE.md` игры: команда `npm run dev` в списке команд.

## Отложено (отдельная задача, вне Этапа 6)

**Тайлы карт в standalone.** `src/client/parts/Map.js` просит текстуры по
абсолютному пути `/img/<file>.png` (`tiles.png`, `tiles3.png`, `b1.png` —
их требуют все три карты). Файлы лежат в `packages/engine/public/img/`
движка и в npm-пакет `vimp-engine` не публикуются (`files` их не включает),
поэтому в `npm run dev` отдавать их некому: матч играется, ботов видно на
радаре, но полотно карты пустое, а в консоли — `Failed to load
/img/tiles.png`. Решение (перенести png в `vimp-tanks/public/img/` +
`publicDir` в dev-ветке конфига, либо иначе) вынесено в отдельную задачу.

## Приёмка этапа

1. `npm run core:build && npm run dev` → браузер, форма/автовход, танк
   управляется (W/A/S/D, K/L, J, N/P), 4 бота воюют, панель и `Tab`-таблица
   работают, звуки играют (или молчат с ошибками в консоли, если
   `audio:process` не запускался — вход это не блокирует). Канвасы и HUD
   лежат внутри `#game`, а не в `body` (проверить в инспекторе).
2. В консоли нет `BOT_PLAYERS_ONLY`: голосование `teamChange` ушло раньше
   `/bot 4` и игрок вышел из наблюдателей.
3. Запуск в окружении с отключённым WebRTC (Firefox,
   `media.peerconnection.enabled = false`) тоже работает: solo его не
   использует.
4. Регресс сборки: `npm run build` → `dist/{manifest.json,client.js,host.js,maps,sounds,core-node}`,
   `npm run check:pack` зелёный.
5. `npm test`, `npm run core:test`, `npm run sim`, `npm run sim:scenarios`,
   `npx eslint .` — зелёные.
6. Плагин по-прежнему поднимается в общем лобби движка (ручной smoke с
   мастером) и на dedicated-сервере (Этап 4).
