# B2. Вход + выбор ника (лобби UI) ✅критично ✅ выполнен

## Реализация

Новая тройка MVC `LobbyAuth` (`packages/engine/src/client/components/
{model,view,controller}/LobbyAuth.js`) + разметка `views/includes/lobbyAuth.pug`
(экраны логина/ника) и бейдж `#lobby-user` в `views/includes/lobby.pug`.
Модель говорит с `packages/auth` напрямую (кросс-доменный fetch, минуя
мастер): OAuth-старт/колбэк — навигация верхнего уровня
(`window.location.href`, вне CSP), `POST /nick` — fetch. `boot()` разбирает
`?token=`/`?pendingToken=`/`?authError=` из query string OAuth-редиректа,
иначе восстанавливает identity JWT из `localStorage`. Payload JWT читается
на клиенте без проверки подписи (`packages/engine/src/lib/jwt.js`,
`decodeJwtPayload`) — только для отображения ника; авторитетная проверка —
задача B3. `#lobby` в шаблоне стартует скрытым, `main.js` открывает его
только когда пришли оба события: `welcome` (мастер) и `authenticated`
(LobbyAuth). Конфиг — `packages/engine/src/config/authClient.js` (bundled,
`serviceUrl` под конкретный деплой). CSP `connect-src` мастера
(`config/master.js`, `security.csp`) стала функцией от `authServiceUrl`
(`security.authServiceUrl`, override `VIMP_AUTH_SERVICE_URL`) — иначе
кросс-доменный `POST /nick` блокировался бы в проде. Документация —
`docs/en/auth.md`/`docs/ru/auth.md` (раздел «Lobby login»), `docs/en/
client.md`/`docs/ru/client.md` (тройка LobbyAuth). Тесты — `tests/client/
LobbyAuth{Model,View,Ctrl}.test.js`, `tests/lib/jwt.test.js`.

Не реализовано на этом этапе (B3): проброс JWT в комнату и его верификация
хостом по `/jwks` — вход всё ещё идёт через комнатную тройку `Auth` со
свободным вводом имени, `LobbyAuth` только открывает лобби.

- Лобби (`packages/engine/src/client/main.js`, `initLobby`) получает состояние
  «залогинен/нет». Кнопки входа Google/Apple/GitHub → редирект на auth-сервис →
  callback возвращает JWT. При первом входе — экран «придумай ник» (глобальная
  уникальность проверяется сервисом).
- JWT хранится клиентом; ник отображается в лобби. Логаут/refresh — по сроку
  токена.
- CSP (`config/master.js` `security.csp`) расширить: `connect-src`/`form-action`/
  при необходимости `frame-src`/`script-src` для доменов провайдеров и
  auth-сервиса. Сейчас политика жёсткая (`default-src 'self'`).

## Критические файлы

`packages/engine/src/client/main.js` + `components/{model,view,controller}/Auth.js`
+ `views/includes/auth.pug` (логин, экран ника, проброс JWT);
`packages/engine/src/config/master.js` (CSP).

## Предусловие

B1 (auth-сервис и его REST-эндпоинты должны существовать).
