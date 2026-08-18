# Этап 6. Тесты генератора и тяжёлый E2E в CI

Шаблон — код, который никто не компилирует в репозитории движка: он
существует только в виде токенизированных файлов. Единственная реальная
защита от дрейфа за контрактом — регулярно разворачивать его и прогонять
полный цикл.

## 6.1. Быстрый уровень (входит в `npm test`)

Помимо тестов генератора из этапа 2, добавляется
`tests/scaffold/template.test.js`:

1. генерация во временный каталог (`mkdtemp`) с `--yes --engine-path
   packages/engine`;
2. симлинк `node_modules/vimp-engine` → `packages/engine` внутри
   сгенерированного проекта (`npm install` не запускается);
3. прогон JS-правил `vimp-contract` (группы B, C, D) прямо по исходникам
   игры — импорт `src/host/index.js` и `src/client/index.js` уже
   резолвится;
4. проверка отсутствия незаменённых токенов и наличия ключевых файлов.

Секунды, без сети, без Rust — но ловит львиную долю расхождений между
шаблоном и контрактом.

## 6.2. Тяжёлый уровень (только CI и opt-in локально)

Новый job `scaffold` в `.github/workflows/test.yml`, рядом с `lint` и
`engine`:

```yaml
scaffold:
  runs-on: ubuntu-latest
  steps:
    - checkout, setup-node 24, dtolnay/rust-toolchain@stable
    - cache cargo (ключ по Cargo.lock, как в job engine)
    - установка wasm-pack
    - npm ci
    - npm pack -w vimp-engine            # тарболл текущего движка
    - генерация игры во временный каталог:
        node packages/create-vimp-game/bin/create-vimp-game.js "$RUNNER_TEMP/e2e-game" \
          --yes --id e2e-game --engine-path <tarball> --core-path packages/engine/core
    - в сгенерированной игре: npm install
    - npm run core:build
    - npm run check:contract
    - npm run build
    - npm test
    - npm run sim
    - npx eslint .
```

Ключевой момент — **проверка идёт против несобранного релиза**: движок
ставится тарболлом `npm pack`, а крейт подменяется через
`[patch.crates-io] vimp-engine-core = { path = "packages/engine/core" }`.
Иначе E2E проверял бы шаблон против уже опубликованных версий и пропускал
бы именно те поломки контракта, которые вносит текущая ветка.

Локальный эквивалент: корневой скрипт `npm run test:scaffold` →
`packages/create-vimp-game/scripts/e2e.js`, те же шаги. В `npm test` он не
входит: `wasm-pack build --release` — минуты.

## 6.3. Что job обязан ловить

- изменение `ENGINE_API_VERSION` или движковой валидации `gameConfig`, не
  отражённое в шаблоне;
- расхождение пинов `vimp-engine` / `vimp-engine-core`;
- поломку любого из 12 инвариантов headless-раннера;
- отвалившуюся ветку загрузки `entries.wasmNode` (ошибка, которая
  проявляется только в установленном пакете, а не в dev-чекауте).

## Готовность этапа

- [ ] `npm test` в репозитории движка остаётся быстрым и зелёным.
- [ ] Job `scaffold` зелёный на ветке.
- [ ] Намеренная поломка шаблона (например, `interp` на `u8`-поле) роняет
      быстрый тест, а поломка ядра — job `scaffold`. Проверяется вручную
      один раз, результат фиксируется в отчёте об этапе.
