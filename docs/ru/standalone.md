# Standalone SDK (браузер)

`vimp-engine/standalone` поднимает полноценный матч внутри одной вкладки:
авторитетный хост, клиент и плагин игры живут на странице. Ни мастер-сервера,
ни OAuth, ни экрана лобби. Существует ради репозитория *игры*: `npm run dev`
там должен открывать играбельный матч против scripted-участников самой игры.

Dedicated-сервер на Node.js — другой контур, см.
[network.md](network.md) (транспорты) и [deployment.md](deployment.md)
(запуск серверов).

## Быстрый старт

Поставьте движок в репозитории игры (обычная зависимость dev-контура) и
добавьте три файла.

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>my-game — dev</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #000;
      }
      /* контейнер SDK обязан быть полноэкранным и позиционированным */
      #game {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="game"></div>
    <script type="module" src="/dev/main.js"></script>
  </body>
</html>
```

`dev/main.js`:

```js
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from '../src/host/index.js';
import clientPlugin from '../src/client/index.js';
import wasmUrl from '../core/pkg/my_game_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'),
  assetsBase: '/assets/',
  playerName: 'dev',
  playerModel: 'm1',
  startupVotes: [['teamChange', 'team1']],
  startupCommands: ['/bot 4'],
  room: { map: 'arena', maxPlayers: 8 },
});
```

Стиль движка импортирует сам клиент, поэтому сборке ничего добавлять не
нужно; экспорт `vimp-engine/style.css` существует для контуров, которые
предпочитают подключать его явно (`import 'vimp-engine/style.css'`).

`vite.config.js`:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // два экземпляра PixiJS = два реестра расширений и мёртвый рендер
    dedupe: ['pixi.js'],
  },
  optimizeDeps: {
    // движок публикуется ESM-исходниками: пребандлинг ломает его
    // динамические импорты и модульный boot-конфиг, общий с SDK
    exclude: ['vimp-engine'],
  },
  server: {
    // нужно только при `npm link`: слинкованный пакет лежит вне корня
    fs: { allow: ['..'] },
  },
});
```

## API

```js
startStandaloneGame(options): Promise<{ stop(): void }>
```

| Опция | Умолчание | Значение |
| --- | --- | --- |
| `hostPlugin` | — | живой объект `HostPlugin` (обязателен) |
| `clientPlugin` | — | живой объект `ClientPlugin` (обязателен) |
| `wasmUrl` | — | URL **web**-сборки ядра игры (обязателен) |
| `container` | `document.body` | точка монтирования каркаса интерфейса *и* канвасов |
| `assetsBase` | `'/'` | база ассетов игры; звуки берутся из `${assetsBase}sounds/` |
| `playerName` | — | задан → форма авторизации пропускается, вход гостевой |
| `playerModel` | — | поле `model` игровой `authSchema` |
| `auth` | `{}` | прочие поля `authSchema` игры |
| `startupVotes` | `[]` | ответы на initialVote, например `[['teamChange', 'team1']]` |
| `startupCommands` | `[]` | чат-команды игры после голосований, например `['/bot 4']` |
| `room` | `{}` | переопределения комнаты: `map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed` |
| `devMode` | `false` | `room.isDevMode`: рекордер матча и хостовый лог `CONSOLE` |

Оба плагина сверяются с `ENGINE_API_VERSION` до всего остального: плагин,
собранный под другую версию API движка, отбивается сразу, а не падает
где-то в середине хендшейка.

`stop()` закрывает транспорт, и матч гасится целиком: снимается рендер-луп,
уничтожается inline-хост (иначе его таймеры продолжали бы крутиться),
освобождаются звук и клавиатура.

### Контейнер

Контейнер обязан быть **полноэкранным и позиционированным**
(`position: relative`). `#panel`, `#stat` и создаваемый в рантайме `#vote` —
`position: absolute`, а их containing block — ближайший позиционированный
предок. Движок достраивает недостающие элементы интерфейса внутри контейнера
и монтирует туда же игровые канвасы; элементы, которые игра положила в свою
разметку сама (`<canvas id="vimp">`, `#chat`, …), переиспользуются как есть и
никуда не переносятся.

Движок также ставит на контейнер класс `vimp-shell`: `style.css` скрывает
`.vimp-shell > *`, чтобы экраны движка не показались разом, а
`body > .vimp-shell { display: revert }` оставляет видимым сам контейнер.
Поэтому контейнеру — прямому потомку `body` — правило `display` от страницы не
нужно (заданный по id `display` по-прежнему выигрывает). На контейнер,
вложенный глубже первого уровня, исключение не распространяется — страница
обязана задать ему `display` сама.

### wasmUrl и ассеты

`wasmUrl` — web-сборка ядра игры, импортированная с суффиксом Vite `?url`:
сборщик кладёт файл в выдачу и возвращает его URL. Node-сборка ядра
(`entries.wasmNode`) предназначена headless-раннеру и dedicated-серверу, во
вкладке она не используется.

Звуки ищутся под `${assetsBase}sounds/`. Их отсутствие не блокирует вход:
`SoundManager.init` грузит их через `Promise.allSettled` и только пишет
ошибки в консоль.

### startupVotes раньше startupCommands

Игрок входит **наблюдателем**, а игра вправе требовать активной команды для
своих чат-команд (у танков `/bot` отбивается наблюдателю). Выйти из
наблюдателей можно только ответом на initialVote, поэтому `startupVotes`
обязаны нести `['teamChange', '<team>']` и уходят **строго раньше**
`startupCommands`. Обе пачки отправляются на первом renderTick после первого
кадра.

Понятия «бот» у движка нет: scripted-участников спавнит *игровая*
чат-команда, объявленная в `hostPlugin.chatCommands` — отсюда
`startupCommands: ['/bot 4']`, а не опция `bots: 4`. Их число должно
укладываться в `room.maxPlayers`, иначе игра отобьёт часть пачки.

## Чем solo отличается от прода

| | прод (лобби) | standalone (solo) |
| --- | --- | --- |
| хост | Web Worker во вкладке создателя комнаты | **главный поток** (inline), без Worker'а |
| личность | OAuth через `packages/auth`, JWT проверяет хост | гостевая: ник из формы или из `playerName` |
| rank / state | читаются и сбрасываются через мастера | offline-заглушка, ничего не сохраняется |
| каталог игр | `GET /games/manifest.json` у мастера | манифест в памяти, собранный из плагина |
| карты | каталог карт мастера, горячие обновления | карты из `gameConfig` |
| транспорт | WebRTC (или loopback для хоста-игрока) | loopback к inline-хосту |
| эстафета Worker'ов на новый код | есть | неприменима |

Хост крутится inline, потому что `HostPlugin` непередаваем через
`postMessage` (функции не клонируются), а SDK получает именно живой объект.
Расхождение dev и прода осознанное.

Полезное следствие: `solo` не касается ни WebRTC, ни module-worker'ов — они
задействованы только на lobby-путях, — поэтому игра стартует в браузере с
полностью отключённым WebRTC.

## Если что-то не работает

- **Пустой канвас без ошибок** — два экземпляра PixiJS. Добавьте
  `resolve.dedupe: ['pixi.js']`.
- **Интерфейс собран в левом верхнем углу** — контейнер не
  `position: relative` или не полноэкранный.
- **Чёрный экран при явно идущем матче** (звук играет, ошибок нет) — контейнер
  скрыт: он вложен глубже первого уровня `body`, куда правило
  `body > .vimp-shell { display: revert }` не достаёт. Задайте ему собственный
  `display` или поднимите на уровень `body`.
- **`/bot` отвечает «только для игроков»** — не заданы `startupVotes`, игрок
  всё ещё наблюдатель.
- **`game "<id>" requires engine API vN`** — плагин и установленный
  `vimp-engine` из разных поколений API; выровняйте версии.
