# Этап 5. Доки, конфиг, тесты ✅ выполнен

Цель: свести изменения в документацию (правило CLAUDE.md — функциональное
изменение правит парные `docs/en/` и `docs/ru/`), конфиг и финальную проверку.

## 5.1. Документация (en + ru синхронно)

| Изменение | Страница |
| --- | --- |
| `/like`·`/unlike` вместо `/ban`, опкоды/протокол голоса, закрытие WS | `network.md` |
| эндпоинты голоса, `GET /servers` с `rating`, блокировка хостера | `master.md` |
| леджер rank, снапшоты state, аннулирование, схема БД, приватный эндпоинт | `auth.md` |
| диапазон рейтинга `min/max/blockAt`, замена `banThreshold`/`reportWindowMs` | `configuration.md` |
| контракт записи в профиль: **rank — общий формат, skills — namespace игры**, курируемый `gameId`, оговорка про откат skills | `plugin-api.md` |

- Также обновить оговорку в `plan/README.md`/доках: рейтинг серверов — это
  **социальный анти-чит**, компенсирующий подделываемость результатов в P2P.

## 5.2. Конфиг

- `packages/engine/src/config/master.js` — блок `host.rating { min, max, blockAt }`
  вместо `banThreshold`/`reportWindowMs`; при необходимости прод-оверрайд через
  env (как `GAMES_MATRIX`).
- Валидатор rank-диапазона на auth (`packages/auth/src/config/auth.js` или
  `lib/validators.js`).

## 5.3. Финальная проверка

- `npx eslint .` — зелёный.
- `npm test` — зелёный (auth + master + client).
- `npm run auth:db:migrate` применяет новые миграции (003) на чистой БД.
- Ручной smoke: два аккаунта, комната, `/like`/`/unlike`, изменение мнения,
  падение до `blockAt` → комната снята, хостер не может создать новую, rank/skills
  игроков откатились; рейтинг виден в лобби.

## Готово, когда

Доки en+ru обновлены синхронно с кодом, конфиг и валидаторы на месте, все
проверки зелёные, миграции применяются, ручной smoke пройден.

## Итог

- **5.1**: конфиг и валидаторы (`master.js: host.rating`,
  `auth.js: rank/state/rating`, `lib/validators.js`) уже были заведены на
  этапах 1–4 вместе с кодом; `banThreshold`/`reportWindowMs` в кодовой базе
  не осталось (проверено `grep`). Из документации не хватало контракта
  «rank — общий формат, skills — namespace игры» — добавлен новый раздел
  «Profile writes: rank & skills» в `docs/en/plugin-api.md` +
  «Запись в профиль: rank и skills» в `docs/ru/plugin-api.md` (после
  ClientPlugin/Wasm ABI, перед Versions/Версии), со ссылками на
  `auth.md#schema`/`#схема-бд` и `master.md#server-rating-likeunlike`/
  `#рейтинг-сервера-likeunlike`. Поправлена устаревшая формулировка
  «social moderation»/«соц-модерация» в `architecture.md` (en+ru) на
  «server rating (social anti-cheat)». Дополнена оговорка в
  `plan/README.md` про недоверенный хост — уточнено, что `/like`·`/unlike`
  это компенсирующая соц-мера, не защита от подделки как таковой.
- **5.2**: конфиг и валидаторы — без изменений (заведены раньше).
- **5.3**: `npx eslint .` — чисто; `npm test` — 758/758 зелёных. Применение
  миграций (`npm run auth:db:migrate` на чистой БД) и ручной smoke
  (`/like`·`/unlike`, откат при блокировке, рейтинг в лобби) требуют
  локального Postgres — недоступен в этой сессии (`pg_isready` не отвечает),
  не проверено автоматически; миграции 003/004 применялись и покрывались
  тестами репозитория на этапах 1–2, но живой прогон `db:migrate` +
  браузерный smoke остаются за пользователем.
