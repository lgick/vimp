# Этап 3 — Реестры словарей вместо констант

**Проблема.** Движок держит закрытые словари, из которых игра выбирает
значения. Сокращение такого словаря отвергает игры, которые пользовались
выбывшим значением, — именно это произошло при `v2 → v3`, когда набор
`control` урезали до четырёх нативных элементов
(`src/client/lib/formBuilder.js:6`), выкинув `range`, `number`, `toggle`,
`segmented`.

**Результат этапа:** каждый такой словарь становится append-only реестром с
механизмом вывода из эксплуатации через алиас. Сжатие словаря становится
структурно невозможным (страж из этапа 1), а выбывшее значение продолжает
работать вечно.

## 3.1 Форма реестра

Общая форма, одинаковая для всех четырёх словарей — новый модуль
`packages/engine/src/lib/registry.js`:

```js
// Append-only реестр (И1). Запись НИКОГДА не удаляется: игра, собранная
// два года назад, могла её написать, и её dist больше никто не тронет.
// Вывод из эксплуатации = { alias: 'новое-имя' } + запись в CHANGELOG,
// но не удаление строки.
export function createRegistry(name, entries) { … }
```

Каждая запись — либо активное значение, либо алиас:

```js
{ value: 'text',  since: 1 }
{ value: 'range', since: 1, alias: 'text', retiredIn: 3,
  note: 'нативного range нет; рисуется как numeric text' }
```

API реестра: `has(name)`, `resolve(name)` (проходит цепочку алиасов),
`list()` (для слепка), `isRetired(name)`.

`resolve` на неизвестном имени возвращает `undefined` — это **всегда** ошибка
плагина (он попросил будущее), никогда не ошибка движка за то, что у него
список длиннее.

## 3.2 Словарь `control` формы

`packages/engine/src/lib/formControls.js` — реестр:

| Имя | Статус | Разрешается в |
| --- | --- | --- |
| `select` | активен | — |
| `text` | активен | — |
| `checkbox` | активен | — |
| `radio` | активен | — |
| `range` | выведен в v3 | `text` + `numeric: true` |
| `number` | выведен в v3 | `text` + `numeric: true` |
| `toggle` | выведен в v3 | `checkbox` |
| `segmented` | выведен в v3 | `radio` |

`src/client/lib/formBuilder.js` разрешает `descriptor.control` через реестр
до выбора билдера. `OPTION_CONTROLS` (`formBuilder.js:15`) считается после
разрешения алиаса, чтобы `segmented` попал в ветку вариантов.

Для `range`/`number` алиас доливает `numeric: true` в дескриптор — иначе
поле, которое было числовым, станет свободным текстом и валидация
`isNumeric` (`formBuilder.js:19`) его пропустит. Это делается в одном месте:
функция разрешения возвращает `{ control, patch }`, билдер применяет `patch`
поверх дескриптора.

Правило контракта `b5-room-form.js` начинает предупреждать (`WARN`) при
использовании выведенного контрола — новая игра его писать не должна, но
старая продолжает работать.

## 3.3 Реестр клиентских сервисов

`SERVICES` из `devtools/contract/rules/c4-component-dependencies.js:10`
переезжает в `packages/engine/src/config/clientServices.js` как реестр (пять
имён: `renderer`, `soundManager`, `assetsBase`, `localPlayer`, `accolades`).
Правило `c4` импортирует его оттуда.

Ключевое поведение, фиксируемое явно: **пул отдаёт запрошенное, а не всё
подряд**, и незнакомое имя в `componentDependencies` — не отказ загрузки, а
`undefined` в парте (сегодня уже так, `c4` существует именно потому, что это
выглядит как чистый холст без ошибок). Правило `c4` при этом остаётся
`ERROR` — оно работает на этапе разработки игры, а не в рантайме.

Добавление шестого сервиса не требует ничего от старых игр: они его не
просят и не получают. Это фиксируется тестом
`tests/client/clientServices.test.js`: плагин, объявивший подмножество
сервисов, получает ровно его.

## 3.4 Порты

`src/config/wsports.js` — номера уже фактически append-only, но правило не
записано и не проверяется. Добавляется:

- шапка-комментарий: номер **никогда** не переиспользуется и не
  перенумеровывается; выведенный из эксплуатации порт остаётся в файле с
  пометкой `retired`, чтобы номер не был выдан повторно;
- раздел `ports` в слепке (этап 1) следит за этим механически: удаление или
  смена номера валит тест.

**Найденный дефект (чинится в этом этапе).** `src/client/main.js:1276`
диспетчеризует входящее сообщение как `socketMethods[msg[0]](msg[1])`, где
`socketMethods` — разрежённый массив (`main.js:273`). Порт без обработчика
даёт `TypeError: socketMethods[...] is not a function` и роняет обработку
сообщения целиком.

Это не плагинная ось (хост и клиент комнаты — один и тот же бандл движка,
их расхождение ловится `codeVersion`), но это ровно та же хрупкость:
получатель падает от того, что отправитель знает больше. Чинится веткой по
умолчанию — неизвестный порт логируется `console.debug` и игнорируется.
Тест: `tests/client/` — сообщение с несуществующим номером порта не бросает.

## 3.5 Ключи и виды блоков снапшота

Раскладка снапшота приезжает от игры (`gameConfig.snapshot`,
`coreConfig.js:38`) и путешествует в CONFIG_DATA — то есть уже
самоописываема в пределах комнаты, это правильный образец. Здесь нужно
только зафиксировать образец как правило и убедиться, что движковая часть
(`SNAPSHOT_FORMAT_VERSION`, `src/config/opcodes.js:24`) не читается плагином
и потому не является плагинной поверхностью.

Работа этапа: раздел в `docs/{en,ru}/plugin-api.md`, объясняющий, почему
схема снапшота — образцовое место контракта, и запись
`snapshotFormatVersion` в слепок как движковую (не плагинную) величину, чтобы
её изменение попадало в diff и обсуждалось осознанно.

## 3.6 Слепок

Разделы `formControls`, `clientServices`, `ports.server`, `ports.client`
начинают браться из новых реестров (этап 1 писал их из литералов). Записи
алиасов входят в слепок наравне с активными — вывод из эксплуатации не
считается удалением.

## Файлы этапа

Создаются:
- `packages/engine/src/lib/registry.js`
- `packages/engine/src/lib/formControls.js`
- `packages/engine/src/config/clientServices.js`
- `tests/lib/registry.test.js`
- `tests/client/formControls.test.js`

Правятся:
- `packages/engine/src/client/lib/formBuilder.js`
- `packages/engine/src/config/wsports.js` (комментарий + `retired`-механика)
- `packages/engine/src/client/main.js` (безопасное игнорирование неизвестного порта)
- `packages/engine/src/devtools/contract/rules/c4-component-dependencies.js`
- `packages/engine/src/devtools/contract/rules/b5-room-form.js`
- `packages/engine/src/devtools/surface/collect.js`
- `packages/engine/contract/surface.json`

## Проверка этапа

- `npm test`, `npx eslint .` — зелёные.
- Новый тест: дескриптор `{ control: 'range', min: 1, max: 8 }` рендерится
  как числовой `text`-инпут с работающей валидацией; `{ control: 'toggle' }`
  — как `checkbox`.
- Ручная проверка стража: удалить строку `range` из реестра → `npm test`
  падает с текстом про И1. Вернуть.
- Браузерная проверка формы создания комнаты: `npm run dev`, форма обеих игр
  рисуется без изменений (обе используют только активные контролы —
  регрессии быть не должно).

## Changelog

`### Added` — «form `control` values retired in plugin API v3 (`range`,
`number`, `toggle`, `segmented`) are accepted again as permanent aliases of
their native replacements; the engine's plugin-facing vocabularies are now
append-only registries».

## Документация

`docs/{en,ru}/plugin-api.md` — раздел «Form schema» дополняется таблицей
алиасов и правилом append-only. `docs/{en,ru}/client.md` — про реестр
сервисов. `docs/{en,ru}/network.md` — про правило неповторного использования
номеров портов. `docs/ai/` — соответствующая страница.
