# Этап 4 (замечание № 3). Отдельный скрипт настройки dedicated-сервера ✅ выполнен

Имеет смысл только после этапа 3: до него auth-URL для dedicated
действительно обязателен (без реестра игру нечем достать).

## Что подтвердилось

`.github/deployment/add-server.sh` в функции `read_auth_service_url`
(строка 151; цикл 167–176) требует непустой
URL auth-сервиса и не выпускает из цикла;
комментарий выше (строки 161–167) объясняет это тем, что без auth-URL в CSP
сломается вход в лобби. Для лобби-мастера это верно. Для dedicated — нет:
OAuth в этом контуре нет вовсе, личность гостевая
(`packages/engine/src/dedicated/main.js:18`, `createGuestIdentity`), профиль —
офлайн-заглушка (`offlinePlayerData`). Auth-URL нужен там ровно для одного —
сходить в реестр за пакетом игры, и после этапа 3 это полностью
опциональный путь.

## Решение

Новый скрипт `.github/deployment/add-dedicated.sh` — сосед `add-server.sh`,
а не флаг внутри него: у двух сценариев расходятся и вопросы, и генерируемые
файлы, и, главное, обязательность полей.

## Изменения по файлам

### 1. `.github/deployment/lib/common.sh` (новый)

Вынести из `add-server.sh` всё, что нужно обоим скриптам:

- логгеры `info` / `warn` / `error`;
- `check_system_installed` (проверка, что `install-system.sh` уже отработал);
- `read_port`, `read_email`, `read_domain` — интерактивные чтения с
  валидацией;
- `validate_origin` — нормализация origin (срезает хвостовой `/`, требует
  `http(s)://`, запрещает путь после хоста);
- генерация Nginx-конфига из `/etc/nginx/vimp.template` и выпуск
  сертификата;
- работа с каталогом `$HOME/vimp_projects/$DOMAIN` (создание, вопрос
  «Перезаписать?»).

Выносится обязательно: дублировать `validate_origin` и генерацию Nginx в
двух скриптах — гарантированное расхождение. Сам файл — библиотека без
`main`, подключается через `source "$(dirname "$0")/lib/common.sh"`.

### 2. `.github/deployment/add-dedicated.sh` (новый)

Спрашивает:

| Вопрос | Обязателен | Замечания |
| --- | --- | --- |
| Домен | да | `read_domain` из common.sh |
| Порт | да | `read_port` |
| E-mail для сертификата | да | `read_email` |
| Игра: имя npm-пакета или id | да | с необязательным пином: `@vimp-games/tanks@0.16.1` |
| URL central auth-сервиса | **нет** | пустой ввод разрешён — игра тянется прямо из npm (этап 3); введённый прогоняется через `validate_origin` |
| Карта, лимит игроков, время раунда, огонь по своим | нет | у каждого дефолт, пустой ввод оставляет дефолт |

Пишет `.env.prod`:

```
NODE_ENV=production
VIMP_DOMAIN=<домен>
VIMP_GAMES_DIR=/var/vimp/games
VIMP_DEDICATED_GAME=<пакет или id с пином>
VIMP_DEDICATED_ROOM={"map":"…","maxPlayers":8,"roundTime":120000,"friendlyFire":false}
# VIMP_AUTH_SERVICE_URL — только если введён
```

`VIMP_DEDICATED_ROOM` — одна строка JSON без внешних кавычек: так его читает
`env_file` docker compose. Рядом комментарий, что при деплое значение
перезапишется из `SERVERS_MATRIX`, если поле `settings` там задано (этап 5).

Пишет `docker-compose.yml` с тем же томом `vimp-games`, что у лобби-мастера,
и с `ports: 127.0.0.1:<порт>` — как в `add-server.sh` и в генерации внутри
`deploy.yml`.

### 3. `.github/deployment/add-server.sh`

- Подключает `lib/common.sh`, свои копии общих функций удаляет.
- В `read_auth_service_url` рядом со строкой «URL обязателен…» — подсказка:
  «для dedicated-сервера используйте `add-dedicated.sh`, там URL
  необязателен».

### 4. `.github/workflows/deploy.yml`

Проверка каталога проекта остаётся как есть; специфичное для dedicated
появляется в этапе 5.

## Тесты

Shell-скрипты юнит-тестами в репозитории не покрыты вовсе. Проверка — ручной
прогон на тестовом VPS:

1. `./add-dedicated.sh`, auth-URL оставить пустым, игру назвать
   `@vimp-games/tanks`;
2. убедиться, что в `.env.prod` нет `VIMP_AUTH_SERVICE_URL`, а
   `VIMP_DEDICATED_GAME` и `VIMP_DEDICATED_ROOM` на месте;
3. `docker compose up -d` — сервер поднимается, пакет приезжает в
   `/var/vimp/games/tanks/<version>/`;
4. `./add-server.sh` на другом домене по-прежнему требует auth-URL.

## Документация и changelog

- `docs/en/deployment.md` + `docs/ru/deployment.md` — раздел «Добавление
  dedicated-сервера» с таблицей различий с лобби-мастером (что спрашивается,
  что обязательно, какие файлы генерируются).
- `docs/en/dedicated.md` + `docs/ru/dedicated.md` — ссылка на скрипт.
- Changelog: **записи нет** — скрипты деплоя не входят ни в один
  публикуемый артефакт.
