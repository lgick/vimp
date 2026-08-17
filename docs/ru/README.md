# Документация VIMP

Многопользовательская 2D онлайн-игра реального времени на P2P-архитектуре:
браузерный хост (Web Worker + Rust-ядро в WASM) исполняет авторитетную
симуляцию, клиенты на PixiJS подключаются по WebRTC, мастер-сервер (Node.js)
держит лобби и сигналинг.

## Разделы

| Страница | О чём |
| --- | --- |
| [getting-started.md](getting-started.md) | Локальная настройка: установка, подключение локального плагина, HTTPS-сертификаты, auth-сервис, запуск, цикл разработки, тесты, локальный мультиплеер |
| [architecture.md](architecture.md) | Общая архитектура: мастер/хост/клиент, игровой цикл, жизненный цикл соединения, ключевые инварианты |
| [master.md](master.md) | Мастер-сервер (точка входа): реестр комнат, REST-список серверов, каталог карт, сигналинг WebRTC, рейтинг сервера `/like`·`/unlike` |
| [auth.md](auth.md) | Центральный auth-сервис (`packages/auth/`): OAuth-вход, глобальный ник, JWT/JWKS, rank/state по играм |
| [host.md](host.md) | Браузерный хост: Worker с ядром, `GameCoreAdapter`, host-фасад, мета-модули, loopback хоста-игрока, роутер главного потока |
| [core.md](core.md) | Rust-ядро движка (`vimp-engine-core`): структура `packages/engine/core/`, общие трейты/макросы, framing снапшотов, сборка, тесты |
| [client.md](client.md) | Клиентские модули: MVC-компоненты, клиентское ядро (интерполяция/prediction/спавн снарядов), рендеринг, звук |
| [standalone.md](standalone.md) | Standalone SDK (`vimp-engine/standalone`): играбельный матч в одной вкладке без мастера, OAuth и лобби — опции, контейнер, ассеты, чем solo отличается от прода |
| [dedicated.md](dedicated.md) | Dedicated-сервер на Node.js: один матч одной игры 24/7 в процессе Node, прямой WebSocket, развилка точки входа, env-переменные, ограничения |
| [network.md](network.md) | Синхронизация хост‑клиент: WebRTC-каналы, протокол портов, бинарный snapshot-кадр (v3), форматы данных, RTT |
| [configuration.md](configuration.md) | Конфигурация движка: переменные `.env`, все файлы `packages/engine/src/config/` |
| [debugging.md](debugging.md) | Отладочный контур: headless-прогон (`npm run sim`), формат сценария, проверки инвариантов, дампы ядра, рассинхрон предикта, браузерный рекордер |
| [deployment.md](deployment.md) | Развертывание: подготовка VPS, добавление/удаление серверов, CI/CD |
| [publishing.md](publishing.md) | Релиз: скрипт `npm run release`, заголовки CHANGELOG, задающие версию, публикация крейта `vimp-engine-core`, пакета `vimp-engine` и игры-плагина, раскатка прода, порядок между ними |
| [plugin-api.md](plugin-api.md) | Контракты движок ↔ игра-плагин: GameManifest, HostPlugin, ClientPlugin, Wasm ABI, снапшот-схема, версии |

Документация игровых правил и расширения контента (gameplay, extending,
игровые части configuration/core) живёт в репозитории активной
игры-плагина, например
[vimp-tanks/docs/ru/](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/README.md).

Пишете игру-плагин с помощью нейросети? [docs/ai/](../ai/README.md) —
отдельный самодостаточный свод контрактов плагина (плюс процесс генерации и
опросник для интервью с автором игры), рассчитанный на LLM; в двуязычный
контур не входит.

## С чего начать

- **Хочу запустить локально** → [getting-started.md](getting-started.md)
- **Хочу понять, как всё устроено** → [architecture.md](architecture.md), затем [host.md](host.md) / [client.md](client.md) / [network.md](network.md)
- **Хочу гонять свой плагин без мастера** → [standalone.md](standalone.md)
- **Хочу сервер 24/7 без вкладки хостера** → [dedicated.md](dedicated.md)
- **Хочу поднять свой сервер** → [deployment.md](deployment.md)
- **Хочу выкатить обновление** → [publishing.md](publishing.md)
- **В матче что-то молча сломалось** → [debugging.md](debugging.md)
- **Хочу добавить карту/оружие** → доки активной игры-плагина (например, [vimp-tanks/docs/ru/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/extending.md))

> Документация поддерживается вместе с кодом: при изменении функционала соответствующая страница обновляется в том же изменении (правило зафиксировано в [CLAUDE.md](../../CLAUDE.md)).
