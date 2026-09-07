# Этап 8. `vimp-snakes`

Репозиторий: `/Users/dmitry/Sites/my/vimp-snakes` (пакет
`@vimp-games/snakes`).
Предварительное чтение: [`README.md`](README.md) — раздел «Единицы
измерения».
Зависит от: этапов [1](stage_1.md)–[4](stage_4.md) движка (движок должен
быть слинкован локально).

## Почему змейкам почти ничего не нужно

У змеек `mapScale: 1` (`src/config/game.js:80`) и `baseScale: '1:1'`
(`src/config/client.js:89`) — **мировая единица равна экранному пикселю**,
и движковые дефолты применимы почти как есть. Своим у игры является только
габарит игрока: `baseRadius: 14` (`src/data/models.js:44`).

Половина экрана при 1920×1080 — `960 × 540` мировых единиц, поэтому
движковая `virtualElevation: 180` даёт на краю экрана угол `atan(960/180) ≈
79°` (выраженная панорама) и мягкий центр у головы змейки.

## 8.1. `src/config/sounds.js`

Текущий экспорт — последние строки файла (`codecList`, `sounds`). Заменить
на (комментарии в этом репозитории — английские, как весь файл):

```javascript
export default {
  codecList: ['webm', 'mp3'],

  // World units are screen pixels here (mapScale 1, baseScale 1:1), so the
  // engine defaults hold; only the body radius is ours.
  spatial: {
    mode: 'topDown',

    // baseRadius of a snake (src/data/models.js): a crystal picked up under
    // the head is spread evenly across both ears
    innerRadius: 14,
  },

  sounds,
};
```

`virtualElevation` **не объявлять**, если движковые `180` звучат верно.
Если на слух панорама окажется слишком широкой — поднять до `250–350` и
зафиксировать причину комментарием. Это второе и последнее место плана,
решаемое ухом.

## 8.2. Документация игры

`docs/en/configuration.md`, раздел
`## src/config/sounds.js — the sound catalog` (строка 209), и зеркало
`docs/ru/`.

Описать: что объявлено, почему только `innerRadius`, и — явно — что
`virtualElevation` намеренно оставлена движковой. Это ровно тот случай,
который требует документа: читатель, не отличивший осознанное отсутствие
настройки от забывчивости, «починит» его. Ссылаться на движковую
`client.md`, не пересказывать её.

## 8.3. Журнал изменений

`CHANGELOG.md` игры, `## [Unreleased]` → `### Changed`: звук вблизи
слушателя стал непрерывным, объявлен габарит игрока для пространственного
звука.

## Чего НЕ делать

Шаблон
`packages/create-vimp-game/templates/default/src/config/sounds.js` в
репозитории движка **не трогать**: движковые дефолты для минимальной игры
верны, а лишний релизный артефакт (`create-vimp-game`) задача не
оправдывает. Блок упоминается только в `docs/ai/` (этап 6).

## Готово, когда

```bash
npx eslint . && npm test
npm run check:contract        # правило E6 -> pass
```

всё зелёное, и пункт 7 ручного смоука [этапа 9](stage_9.md) пройден.
