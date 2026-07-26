# Д2. PanelView по типам схемы + auth-тексты игры (критично, ~S-M) ✅ выполнен

## Замечание 1 — PanelView

`packages/engine/src/client/components/view/Panel.js` генерирует DOM по
схеме лишь частично: семантика захардкожена по именам полей —
`if (name === 'health')` (бар из 30 блоков, деление на 100, CSS-классы
`panel-health-*`), отдельная логика оружия (`_weaponList`,
`setCurrentWeapon`). §3.3 PLAN.md требует «типы отображения:
bar/число/время/иконка-оружия» в схеме. Игра с полем `energy` вместо
`health` не получит бар.

## Решение 1

- В схему панели добавить `type: 'bar' | 'value' | 'time' | 'weapon'`
  (+ параметры бара: `max`, число блоков `blocks`).
- PanelView рендерит по `type`; CSS-классы нейтральные (`panel-bar-*`).
- Танковая схема (`games/tanks/src/config/game.js` panel.fields) объявляет
  типы; игровой CSS адаптируется.
- Хостовая `meta/modules/Panel.js` не меняется (activeKey уже из схемы).

## Замечание 2 — auth-тексты

Движковый шаблон `packages/engine/src/client/views/includes/auth.pug:5,19-31`
содержит игровые тексты: «VIMP P2P Tank Battle», «move the tank», «turn the
gun», «switch weapon/player». §2 PLAN.md: «index.html — нейтральный shell».

## Решение 2

- Заголовок и help-строки — в `authSchema` игры
  (`games/tanks/src/config/auth.js`): хост уже шлёт `authSchema.elems/params`
  клиенту (`host.worker.js:185-189`) — расширить полем текстов.
- Auth-view подставляет их в DOM; `auth.pug` — нейтральный каркас.
- Зеркально — фикстура miniGame.

## Критерий готовности

В движке нет строк `health`/`Tank Battle`/`move the tank`; панель и
auth-форма выглядят как раньше (smoke); eslint/тесты зелёные; docs en+ru.
