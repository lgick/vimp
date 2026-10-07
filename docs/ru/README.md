# Документация VIMP

Многопользовательская 2D онлайн-игра реального времени на P2P-архитектуре:
браузерный хост (Web Worker + Rust-ядро в WASM) исполняет авторитетную
симуляцию, клиенты на PixiJS подключаются по WebRTC, мастер-сервер (Node.js)
держит лобби и сигналинг.

## Разделы

| Страница                                 | О чём                                                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | Локальная настройка: установка, подключение локального плагина, HTTPS-сертификаты, auth-сервис, запуск, цикл разработки, тесты, локальный мультиплеер                                                           |
| [architecture.md](architecture.md)       | Общая архитектура: мастер/хост/клиент, игровой цикл, жизненный цикл соединения, ключевые инварианты                                                                                                             |
| [master.md](master.md)                   | Мастер-сервер (точка входа): комнаты (`roomId`, эпохи, участники), REST-список серверов, каталог карт, сигналинг WebRTC, арбитраж миграции хоста, голосование `/changehost`                                     |
| [auth.md](auth.md)                       | Центральный auth-сервис (`packages/auth/`): OAuth-вход, глобальный ник, JWT/JWKS, rank/state по играм                                                                                                           |
| [host.md](host.md)                       | Браузерный хост: Worker с ядром, `GameCoreAdapter`, host-фасад, мета-модули, loopback хоста-игрока, роутер главного потока; контрольные точки, преемник и миграция хоста                                        |
| [core.md](core.md)                       | Rust-ядро движка (`vimp-engine-core`): структура `packages/engine/core/`, общие трейты/макросы, framing снапшотов, сборка, тесты                                                                                |
| [client.md](client.md)                   | Клиентские модули: MVC-компоненты, клиентское ядро (интерполяция/prediction/спавн снарядов), рендеринг, звук                                                                                                    |
| [standalone.md](standalone.md)           | Standalone SDK (`vimp-engine/standalone`): играбельный матч в одной вкладке без мастера, OAuth и лобби — опции, контейнер, ассеты, чем solo отличается от прода                                                 |
| [dedicated.md](dedicated.md)             | Dedicated-сервер на Node.js: один матч одной игры 24/7 в процессе Node, прямой WebSocket, развилка точки входа, env-переменные, ограничения                                                                     |
| [network.md](network.md)                 | Синхронизация хост‑клиент: WebRTC-каналы, протокол портов, бинарный snapshot-кадр (v5), форматы данных, RTT; возобновление сессии и протокол миграции                                                           |
| [configuration.md](configuration.md)     | Конфигурация движка: переменные `.env`, все файлы `packages/engine/src/config/`                                                                                                                                 |
| [debugging.md](debugging.md)             | Отладочный контур: headless-прогон (`npm run sim`), формат сценария, проверки инвариантов, дампы ядра, рассинхрон предикта, браузерный рекордер                                                                 |
| [deployment.md](deployment.md)           | Развертывание: подготовка VPS, добавление/удаление серверов, CI/CD                                                                                                                                              |
| [publishing.md](publishing.md)           | Релиз: скрипт `npm run release`, заголовки CHANGELOG, задающие версию, публикация крейта `vimp-engine-core`, пакета `vimp-engine` и игры-плагина, раскатка прода, порядок между ними                            |
| [scaffolding.md](scaffolding.md)         | Скаффолдер `npm create vimp-game`: флаги, состав минимальной игры, цикл проверки (`check:contract` → `core:test` → `sim` → `dev`), разработка против локального чекаута движка                                  |
| [plugin-api.md](plugin-api.md)           | Контракты движок ↔ игра-плагин: GameManifest, HostPlugin, ClientPlugin, Wasm ABI, снапшот-схема, версии                                                                                                         |
| [packaging.md](packaging.md)             | Упаковка и сборка игрового плагина: раскладка репозитория, `package.json`, генерация манифеста, две сборки Vite, wasm-pack, скрипты ассетов, `dist/`, dev-режим, документация, которую обязан поставлять плагин |
| [maps-and-assets.md](maps-and-assets.md) | Формат карты (уровни, рампы, масштабирование, респауны), картинки, конвейер звуков, запечённые ассеты                                                                                                           |
| [pitfalls.md](pitfalls.md)               | Чек-лист «тихих» контрактов и таблица правил `vimp-contract`                                                                                                                                                    |

Документация игровых правил и расширения контента (gameplay, extending,
игровые части configuration/core) живёт в репозитории активной
игры-плагина —
[vimp-tanks/docs/ru/](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/README.md)
и [vimp-snakes/docs/ru/](https://github.com/lgick/vimp-snakes/blob/main/docs/ru/README.md).

Пишете игру-плагин с помощью нейросети? [docs/ai/](../ai/README.md) — тонкий
мета-слой, а не вторая копия контракта: порядок чтения страниц выше, процесс
генерации и опросник для интервью. В двуязычный набор не входит.

## С чего начать

- **Хочу запустить локально** → [getting-started.md](getting-started.md)
- **Хочу понять, как всё устроено** → [architecture.md](architecture.md), затем [host.md](host.md) / [client.md](client.md) / [network.md](network.md)
- **Хочу начать новый игровой плагин** → [scaffolding.md](scaffolding.md)
- **Хочу гонять свой плагин без мастера** → [standalone.md](standalone.md)
- **Хочу сервер 24/7 без вкладки хостера** → [dedicated.md](dedicated.md)
- **Хочу поднять свой сервер** → [deployment.md](deployment.md)
- **Хочу выкатить обновление** → [publishing.md](publishing.md)
- **Хочу собрать и упаковать плагин** → [packaging.md](packaging.md), затем [maps-and-assets.md](maps-and-assets.md)
- **В матче что-то молча сломалось** → [debugging.md](debugging.md), [pitfalls.md](pitfalls.md)
- **Хочу добавить карту/оружие** → доки активной игры-плагина (например, [vimp-tanks/docs/ru/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/extending.md))

> Документация поддерживается вместе с кодом: при изменении функционала соответствующая страница обновляется в том же изменении (правило зафиксировано в [CLAUDE.md](../../CLAUDE.md)).

## Какую страницу обновлять

Функциональное изменение обновляет соответствующую страницу здесь и в `docs/en/` в том же изменении. Пути — относительно `packages/engine/`, если не указано иное.

| Изменение                                              | Страница                          |
| ------------------------------------------------------ | --------------------------------- |
| порты, формат кадра, опкоды                            | network.md                        |
| `src/config/*`, переменные окружения                   | configuration.md                  |
| `src/master/`                                          | master.md                         |
| `packages/auth/`                                       | auth.md                           |
| `src/host/` (Worker, адаптер, meta)                    | host.md                           |
| крейт `core/`                                          | core.md                           |
| `src/client/`, ClientCore                              | client.md                         |
| `src/standalone/` (браузерный SDK)                     | standalone.md                     |
| `src/dedicated/` (Node-сервер игры)                    | dedicated.md                      |
| контракт плагина, Wasm ABI                             | plugin-api.md                     |
| `src/devtools/`, `bin/vimp-*.js`                       | debugging.md                      |
| `packages/create-vimp-game/` (генератор, шаблон)       | scaffolding.md                    |
| структура пакета, сборка, `dist/`, генерация манифеста | packaging.md                      |
| JSON карт, изображения, звуковой конвейер              | maps-and-assets.md                |
| `src/devtools/contract/rules/`, молчаливые контракты   | pitfalls.md                       |
| скрипты деплоя, workflows, npm-скрипты                 | deployment.md, getting-started.md |
| процесс релиза, `files`, версии, пин плагина           | publishing.md                     |
