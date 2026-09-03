# Этап 1. `deploy.yml`: `VIMP_DEDICATED_ROOM` уезжает многострочным ✅ выполнен

**Находка:** F1 в [review.md](review.md). Уровень: 🔴 критично — ломает
деплой любого dedicated-бокса с полем `settings` в `SERVERS_MATRIX`.

## Что сломано

`.github/workflows/deploy.yml`, блок `env:` шага деплоя (около строки
240):

```yaml
VIMP_DEDICATED_ROOM: ${{ toJSON(matrix.settings) }}
```

`toJSON` в GitHub Actions печатает объекты и массивы **с отступами и
переводами строк**; компактно выводятся только скаляры и `null`. Для
`settings: { maxPlayers: 8 }` переменная получает три строки. Ниже, в
`script:`, они попадают в `.env.prod`:

```bash
if [ -n "$VIMP_DEDICATED_GAME" ] && [ -n "$VIMP_DEDICATED_ROOM" ] \
   && [ "$VIMP_DEDICATED_ROOM" != "null" ]; then
  echo "VIMP_DEDICATED_ROOM=$VIMP_DEDICATED_ROOM"
fi
```

`env_file` docker compose читает файл построчно и на строке
`  "maxPlayers": 8` спотыкается: контейнер не стартует.

## Что сделать

### 1.1. Схлопнуть JSON на раннере

В job'е деплоя, **до** шага `appleboy/ssh-action`, добавить шаг,
превращающий значение матрицы в одну строку. `jq` предустановлен на
`ubuntu-latest`.

```yaml
      # settings матрицы — объект, а toJSON печатает его с переводами
      # строк. В .env.prod значение обязано быть одной строкой: env_file
      # docker compose читает файл построчно
      - name: Compact dedicated room settings
        id: room
        env:
          RAW: ${{ toJSON(matrix.settings) }}
        run: |
          set -e
          COMPACT=$(printf '%s' "$RAW" | jq -c .)
          # поля settings в матрице нет -> jq вернёт "null": в .env.prod
          # такая строка не пишется вовсе (readDedicatedRoom бросил бы
          # 'expected a JSON object')
          if [ "$COMPACT" = "null" ]; then
            COMPACT=""
          fi
          echo "json=$COMPACT" >> "$GITHUB_OUTPUT"
```

Замечания исполнителю:

- имя шага и `id: room` можно менять, но `steps.room.outputs.json`
  ниже должен совпасть;
- `$GITHUB_OUTPUT` не принимает многострочные значения без heredoc —
  после `jq -c` их и не будет; это и есть страховка от повторения
  ошибки;
- `jq -c .` заодно проверяет, что значение вообще JSON: битая матрица
  уронит деплой на раннере с внятным текстом, а не на сервере молча.

### 1.2. Передавать в ssh-action уже компактное значение

В блоке `env:` шага деплоя заменить строку на:

```yaml
          # компактный JSON одной строкой (шаг «Compact dedicated room
          # settings»): toJSON здесь напрямую нельзя — он многострочный
          VIMP_DEDICATED_ROOM: ${{ steps.room.outputs.json }}
```

Список `envs:` не менять — `VIMP_DEDICATED_ROOM` там уже перечислен.

### 1.3. Защита на сервере

В `script:` заменить условие записи на такое, которое не пропустит
многострочное значение, даже если наверху снова что-нибудь изменится:

```bash
              # Одна строка JSON без внешних кавычек — так его читает
              # env_file docker compose. Значение с переводом строки в
              # .env.prod не пишется вовсе: сломанный env_file не даёт
              # контейнеру подняться, а отсутствие переменной — всего
              # лишь дефолтные настройки комнаты
              if [ -n "$VIMP_DEDICATED_GAME" ] && [ -n "$VIMP_DEDICATED_ROOM" ] \
                 && [ "$VIMP_DEDICATED_ROOM" != "null" ] \
                 && [ "$(printf '%s' "$VIMP_DEDICATED_ROOM" | wc -l)" -eq 0 ]; then
                echo "VIMP_DEDICATED_ROOM=$VIMP_DEDICATED_ROOM"
              else
                if [ -n "$VIMP_DEDICATED_GAME" ] && [ -n "$VIMP_DEDICATED_ROOM" ] \
                   && [ "$VIMP_DEDICATED_ROOM" != "null" ]; then
                  echo "WARN: VIMP_DEDICATED_ROOM contains a newline — skipped" >&2
                fi
              fi
```

(`wc -l` считает переводы строк; у однострочного значения без хвостового
`\n` результат `0`.)

Если такая вложенность покажется громоздкой, допустима равнозначная
форма: сначала нормализовать переменную в отдельную (`ROOM_LINE`), затем
одно условие на запись. Требование одно — многострочное значение в
`.env.prod` не попадает и о нём сказано в логе.

## Тесты

Юнит-тестом workflow не покрывается. Обязательный минимум:

1. `tests/config/env.test.js` — добавить случай: строка с переводом
   строки внутри (`'{\n  "maxPlayers": 8\n}'`) читается `readDedicatedRoom`
   корректно (JSON.parse переводы строк переживает) — это фиксирует, что
   проблема именно в формате `.env`, а не в движке, и объясняет, почему
   тест движка её и не поймал. Комментарий в тесте обязателен.
2. Ручная проверка на тестовом VPS (см. ниже).

## Документация

- `docs/en/deployment.md` и `docs/ru/deployment.md` — в разделе про
  `SERVERS_MATRIX`/`settings`: значение схлопывается в одну строку на
  раннере (`jq -c`), поэтому в матрице `settings` пишется обычным
  объектом YAML/JSON и переносы строк в нём допустимы. Убрать прежнее
  требование «без переводов строк в значениях», если оно там осталось,
  и заменить на «в *значениях полей* переводов строк быть не должно».

Changelog не трогать — `.github/` не входит в публикуемые артефакты.

## Ручная проверка

1. В `SERVERS_MATRIX` тестового окружения задать для dedicated-домена
   `settings: { "maxPlayers": 4, "roundTime": 60000 }`.
2. Прогнать деплой.
3. На сервере: `cat ~/vimp_projects/<домен>/.env.prod` — строка
   `VIMP_DEDICATED_ROOM={"maxPlayers":4,"roundTime":60000}` одна.
4. `docker compose ps` — контейнер поднят; в логах нет жалоб на
   `env_file`.
5. Убрать `settings` из матрицы, прогнать деплой снова: переменной в
   `.env.prod` нет, сервер стартует на дефолтах.
