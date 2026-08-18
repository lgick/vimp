# Этап 7. Документация и релизная гигиена ✅ выполнен

## 7.1. Двуязычная документация движка

Новая страница `docs/en/scaffolding.md` и её зеркало
`docs/ru/scaffolding.md` (правило: обе в одном изменении):

- `npm create vimp-game <dir>` — флаги, интерактив, что получается на
  выходе;
- состав минимальной игры и что автор дописывает первым делом;
- цикл проверки: `check:contract` → `core:test` → `sim` → `dev`;
- локальная разработка против чекаута движка (`--engine-path`,
  `--core-path`, двусторонний `npm link`).

Правки-спутники:

- строка в таблице ToC обоих `docs/{en,ru}/README.md` и пункт в блоке
  «Where to start» («I want to start a new game plugin → scaffolding.md»);
- корневой `CLAUDE.md`: строка в таблице «Area → page»
  (`packages/create-vimp-game/` → `scaffolding.md`) и строка команды в блоке
  `Commands`. Файл обязан остаться в пределах 1000 токенов — если растёт,
  сокращаем соседние формулировки, а не добавляем абзацы.

## 7.2. `docs/ai/`

Английский, вне правила зеркальности, но контракт плагина живёт там:

- `11-authoring-workflow.md`, шаг 3 («scaffold repo layout»): вместо
  ручного создания дерева — `npm create vimp-game`, дальше по прежнему
  порядку;
- `13-debugging.md`: `vimp-contract` как обязательный шаг перед `npm run
  sim` (заведено на этапе 1, здесь — сверка формулировок);
- `10-pitfalls.md`: пометка, какие пункты чек-листа теперь проверяются
  машиной, и что остаётся ручным код-ревью; **плюс правка устаревшей
  строки 119-120** — «The available dependency services are exactly
  `renderer` and `soundManager`». Пул сервисов расширен до трёх
  (`packages/engine/src/client/main.js:345-352`) направлением
  `game-assets-move` (2026-08-18); соседняя строка 160 того же файла уже
  требует `assetsBase` в `componentDependencies`, то есть файл противоречит
  сам себе;
- `02-packaging.md`: ссылка на шаблон как на исполняемый пример раскладки.

## 7.3. Журналы изменений

- `packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Added`:
  `vimp-contract` (bin + правила). Подзаголовок задаёт уровень релиза —
  **minor** npm-пакета `vimp-engine` (`0.9.0` → `0.10.0`).
- `packages/create-vimp-game/CHANGELOG.md` — новый журнал, первая запись
  под `## [Unreleased]` → `### Added`.
- Крейт `vimp-engine-core` не трогается, `ENGINE_API_VERSION` не меняется:
  репозиториям игр следовать за релизом не обязано, но `vimp-contract`
  станет доступен им после публикации движка.

## 7.4. Порядок публикации

1. `npm run release` публикует `vimp-engine 0.10.0` (крейт пропускается) —
   иначе сгенерированные игры сошлются на несуществующую версию;
2. вручную: `npm publish -w create-vimp-game` (интеграция в
   `npm run release` сознательно отложена — `scripts/release/*` знает
   только крейт и движок, а игры ищет вне воркспейса);
3. перед публикацией скаффолдера — `prepack` обязан записать актуальный
   `src/versions.generated.json`; тест этапа 2 это стережёт.

Версии в `package.json` правит разработчик, не агент.

## 7.5. Закрытие направления

- отметить все этапы `✅ выполнен` в `plan/create-vimp-game/README.md`;
- перенести каталог целиком в `plan/done/create-vimp-game/` (`git mv` для
  отслеживаемых файлов) и добавить строку в `plan/done/README.md`;
- коммит не создавать — изменения остаются в рабочем дереве.

## Готовность этапа

- [x] `docs/en/scaffolding.md` и `docs/ru/scaffolding.md` совпадают по
      структуре, обе прописаны в ToC.
- [x] Корневой `CLAUDE.md` обновлён и укладывается в лимит.
- [x] Оба CHANGELOG заполнены, уровень релиза читается с подзаголовка.
- [x] `npx eslint . && npm test` зелёные, `npm run core:test` зелёный.
