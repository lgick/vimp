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
| [network.md](network.md) | Синхронизация хост‑клиент: WebRTC-каналы, протокол портов, бинарный snapshot-кадр (v3), форматы данных, RTT |
| [configuration.md](configuration.md) | Конфигурация движка: переменные `.env`, все файлы `packages/engine/src/config/` |
| [deployment.md](deployment.md) | Развертывание: подготовка VPS, добавление/удаление серверов, CI/CD |
| [plugin-api.md](plugin-api.md) | Контракты движок ↔ игра-плагин: GameManifest, HostPlugin, ClientPlugin, Wasm ABI, снапшот-схема, версии |

Документация игровых правил и расширения контента (gameplay, extending,
игровые части configuration/core) живёт в репозитории активной
игры-плагина, например
[vimp-tanks/docs/ru/](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/README.md).

## С чего начать

- **Хочу запустить локально** → [getting-started.md](getting-started.md)
- **Хочу понять, как всё устроено** → [architecture.md](architecture.md), затем [host.md](host.md) / [client.md](client.md) / [network.md](network.md)
- **Хочу поднять свой сервер** → [deployment.md](deployment.md)
- **Хочу добавить карту/оружие** → доки активной игры-плагина (например, [vimp-tanks/docs/ru/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/extending.md))

> Документация поддерживается вместе с кодом: при изменении функционала соответствующая страница обновляется в том же изменении (правило зафиксировано в [CLAUDE.md](../../CLAUDE.md)).
