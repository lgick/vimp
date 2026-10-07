# Объединение docs/ai в docs/en (+ docs/ru)

Цель: `docs/en/` — единственный источник правды, `docs/ru/` — точное зеркало, `docs/ai/` —
тонкий мета-слой для ИИ (README-карта, `workflow.md`, `questionnaire.md`).

Решения: дополнить существующие страницы + 3 новые (`packaging`, `maps-and-assets`,
`pitfalls`); `09-reference-implementations` удаляется (ссылки на шаблон create-vimp-game и
vimp-tanks/snakes); 01-architecture → `architecture.md`, 13-debugging → `debugging.md`.

**Правило расхождений:** при конфликте `docs/ai` и `docs/en` победитель определяется по коду
(пример: версия фрейма — v3 в README, v5 в `06-snapshot-protocol.md`). Расхождение, меняющее
наблюдаемый контракт, согласуется до правки. Каждое найденное — в отчёт этапа.

Коммиты — только по явной просьбе. Release impact: правки комментариев в
`packages/create-vimp-game/**` и `packages/engine/src/**` — без записей CHANGELOG и версий.

| Этап                     | Суть                                                            | Статус      |
| ------------------------ | --------------------------------------------------------------- | ----------- |
| [stage_1.md](stage_1.md) | Обогащение существующих страниц (EN → RU)                       | ✅ выполнен |
| [stage_2.md](stage_2.md) | Новые страницы packaging / maps-and-assets / pitfalls (EN → RU) | ✅ выполнен |
| [stage_3.md](stage_3.md) | Переписать `docs/ai/`, удалить 01–10, 13                        | ✅ выполнен |
| [stage_4.md](stage_4.md) | Ссылки, README, CLAUDE.md, комментарии в коде                   | ✅ выполнен |
| [stage_5.md](stage_5.md) | Проверка: prettier, eslint, тесты, ссылки, EN/RU структура      | ✅ выполнен |
