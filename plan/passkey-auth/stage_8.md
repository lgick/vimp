# Этап 8. Деплой, сквозная документация, порядок выката, ручной smoke

Последний этап: после 1–7. Скрипты `.github/`, документация `docs/`,
корневой `README.md`, план ручного smoke. Код движка и auth не меняется
(кроме мелочей, найденных проверками ниже).

## Контекст (проверено по коду 2026-10-07)

- `.github/deployment/add-server.sh` (457 строк): для auth-домена
  спрашивает GitHub OAuth App (`AUTH_GITHUB_CLIENT_ID/_SECRET`, строки
  ~24–25, ~128–137), генерирует `AUTH_STATE_SECRET` (`openssl rand -hex
32`, ~102), собирает `AUTH_ALLOWED_ORIGINS` (~121), спрашивает ники
  админов (`AUTH_ADMIN_NICKS`, ~143–145), создаёт ключи `.keys/jwt.pem`
  (~173–181), пишет `.env.prod` (~188–193: `VIMP_AUTH_PUBLIC_URL`,
  `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`,
  `VIMP_AUTH_GITHUB_CLIENT_ID/_SECRET`, `VIMP_ADMIN_NICKS`), печатает
  итоги (~391–392, ~454). Строка CSP Nginx мастера запекается из шаблона
  `install-system.sh` (`__AUTH_SERVICE_URL__`) при добавлении домена —
  обычный redeploy её не обновляет (см. подсказку в `delete-server.sh`
  ~175–185).
- `.github/workflows/deploy.yml`, job `deploy_auth` (с ~95, `if:
vars.AUTH_SERVER_IP != ''`): `env` — `AUTH_SERVICE_URL`,
  `VIMP_ADMIN_NICKS` (vars), `VIMP_ADMIN_IDENTITIES` (vars),
  `VIMP_CLIENT_REPORTS_TOKEN` (secrets); `envs:` для ssh-action; в
  скрипте — блоки «если переменная непуста — заменить строку в
  `.env.prod`, иначе оставить как есть» (~150–175), затем `migrate.js`
  одноразовым контейнером и `up -d --force-recreate auth`. Jobs
  `deploy_auth` и `deploy` (мастера) идут **параллельно**; ручного
  `workflow_dispatch` нет — повтор через «Re-run jobs» в GitHub UI.
- Документация с OAuth/GitHub/dev-логином: `docs/{en,ru}/auth.md`,
  `getting-started.md` («## Central auth service (needed to reach the
  lobby)» ~108–165, «### Logging in without OAuth (dev only)»),
  `deployment.md` («## Central auth service (`packages/auth`)» ~352–453,
  абзац про `VITE_AUTH_SERVICE_URL` и кнопку «Sign in» ~440–453,
  «## 🔒 Security headers and CSP» ~455), `configuration.md` (env auth),
  `client.md`, `master.md` (~702 «(no OAuth)»), `host.md` (~1473 ссылка
  dev-логина в Manual run checklist), `dedicated.md` (~6, ~226),
  `standalone.md` (~5, ~186 — таблица отличий: «identity | OAuth via
  `packages/auth`…»), `docs/{en,ru}/README.md` (~15, ~19),
  `docs/ai/11-authoring-workflow.md` (~166), корневой `README.md` (~15
  «Accounts: OAuth login and a global nick…»),
  `packages/create-vimp-game/templates/default/dev/main.js` (~2,
  комментарий «no OAuth»), `packages/engine/src/dedicated/main.js` (~82,
  ~570) и `src/standalone/index.js` (~11) — комментарии.
- План ручного smoke миграции хоста `plan/host-migration-smoke.md`:
  «Подготовка» п. 3 (~45–47, профили «залогинены своим аккаунтом» через
  `/dev/login`), сценарий 1.2 (~66, «логин → …»).

## 8.1 `add-server.sh` (auth-домен)

1. Удалить вопросы и переменные GitHub OAuth App, `VIMP_AUTH_PUBLIC_URL`,
   ников админов; печать «Authorization callback URL».
2. Оставить генерацию `AUTH_STATE_SECRET` (теперь подписывает гостевые
   сессии и challenge-токены — поправить текст вывода) и
   `AUTH_ALLOWED_ORIGINS`.
3. Спросить: Turnstile **site key** и **secret** (secret — `read -rs`,
   оба обязательны, с подсказкой «Cloudflare → Turnstile → Add widget,
   mode Managed, домены мастеров»); **WebAuthn rpId** — по умолчанию
   родительский домен auth-домена (отбросить первую метку:
   `auth.vimp.lgick.space` → `vimp.lgick.space`), с пояснением «passkey
   работает на мастерах, чей домен равен rpId или его поддомен»; id
   админов — необязательно (пусто: «задайте VIMP_ADMIN_USER_IDS после
   первой регистрации passkey»).
4. `.env.prod`: `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`,
   `VIMP_AUTH_TURNSTILE_SITE_KEY`, `VIMP_AUTH_TURNSTILE_SECRET`,
   `VIMP_AUTH_WEBAUTHN_RP_ID`, `VIMP_ADMIN_USER_IDS`.
5. Итоговая печать: rpId, домены для виджета Turnstile, напоминание про
   `VIMP_ADMIN_USER_IDS`.
6. `bash -n` и `shellcheck` (если установлен) на изменённых скриптах.

## 8.2 `deploy.yml` (`deploy_auth`)

1. `env`: удалить `VIMP_ADMIN_NICKS`, `VIMP_ADMIN_IDENTITIES`; добавить
   `VIMP_ADMIN_USER_IDS: ${{ vars.VIMP_ADMIN_USER_IDS }}`,
   `VIMP_AUTH_TURNSTILE_SITE_KEY: ${{ vars.TURNSTILE_SITE_KEY }}`,
   `VIMP_AUTH_TURNSTILE_SECRET: ${{ secrets.TURNSTILE_SECRET }}`,
   `VIMP_AUTH_WEBAUTHN_RP_ID: ${{ vars.WEBAUTHN_RP_ID }}`; обновить
   `envs:`.
2. Скрипт: блоки `VIMP_ADMIN_NICKS`/`VIMP_ADMIN_IDENTITIES` заменить тем
   же шаблоном «непусто — заменить строку, пусто — оставить» для четырёх
   новых переменных (комментарий: пустая переменная репозитория не должна
   затирать значение на сервере, как было у списка админов). Отдельно —
   удалить из `.env.prod` устаревшие строки, если они есть:
   `sed -i '/^VIMP_AUTH_GITHUB_CLIENT_ID=/d; /^VIMP_AUTH_GITHUB_CLIENT_SECRET=/d; /^VIMP_AUTH_PUBLIC_URL=/d; /^VIMP_ADMIN_NICKS=/d; /^VIMP_ADMIN_IDENTITIES=/d' .env.prod`.
3. Проверить YAML (`npx prettier --check .github/workflows/deploy.yml`
   или `actionlint`, если доступен).

## 8.3 Документация (en и ru одинаково; ru — зеркало en)

1. `docs/{en,ru}/auth.md` — сквозная вычитка после этапов 1–6: шапка и
   «## Why a separate service» (гостевая личность, passkey, глобальный
   ник, rank/state, JWT/JWKS), «## Running» (dev: Postgres, ключи JWT,
   тестовые ключи Turnstile по умолчанию, rpId `localhost`), «## Schema»,
   «## REST API», «## Passkeys», «## Inactive accounts», «## Lobby login
   (client)», «## Joining a room (host verification)» (`admit` хоста,
   гейт гостя; заодно исправить устаревшее упоминание
   `verifyClientToken` → `createTokenIdentity`), «## Rank and state
   loading and sync (host)» (только участники, 401, `TOKEN_REFRESH`),
   «## Tests» (новые файлы тестов). Нигде не должно остаться OAuth,
   GitHub, pending-токена, `VIMP_ADMIN_NICKS`/`IDENTITIES`.
2. `docs/{en,ru}/getting-started.md`, «## Central auth service …»:
   GitHub OAuth App больше не нужен; ключи JWT — как раньше; `.env` для
   dev (без обязательных Turnstile/rpId — dev-умолчания); лобби открывается
   гостем сразу; «### Logging in without OAuth» → «### Dev accounts»:
   `http://localhost:3010/dev/login?nick=P1&returnUrl=https://localhost:3002/`
   создаёт участника и входит; passkey локально — Chrome DevTools →
   WebAuthn → виртуальный аутентификатор; админ — `VIMP_ADMIN_USER_IDS=<id
из лога dev-логина>`.
3. `docs/{en,ru}/deployment.md`: «## Central auth service» — без GitHub
   OAuth App; Turnstile (создать виджет, домены, `TURNSTILE_SITE_KEY` в
   Variables, `TURNSTILE_SECRET` в Secrets); `WEBAUTHN_RP_ID` (Variable;
   правило домена); админы — `VIMP_ADMIN_USER_IDS` (Variable) после первой
   регистрации passkey; удаление неактивных аккаунтов (задача auth, 00:25
   UTC); абзац о `VITE_AUTH_SERVICE_URL` — «Sign in» → «passkey/guest
   sign-in breaks»; «## 🔒 Security headers and CSP» — Turnstile в
   `script-src`/`frame-src`; новый раздел **«## Rolling out passkey auth
   (one-time order)»** — содержимое 8.5.
4. `docs/{en,ru}/configuration.md` — сверка env auth и `authClient`
   (этапы 2, 6) — ничего старого.
5. `docs/{en,ru}/client.md`, `master.md` (~702), `host.md` (~1473:
   dev-логин в Manual run checklist — новая ссылка; добавить в checklist
   строки «гость входит без логина», «гость создаёт комнату → Turnstile»),
   `dedicated.md` (~6, ~226), `standalone.md` (~5, ~186: строка таблицы
   «identity» → «guest identity or passkey account via `packages/auth`,
   JWT verified by the host»), `docs/{en,ru}/README.md` (~15: «Central
   auth service: guest identities, passkeys, global nick, JWT/JWKS,
   per-game rank/state»; ~19), `docs/ai/11-authoring-workflow.md`
   (~166) — заменить «OAuth» по смыслу («no master, no sign-in, no
   lobby»).
6. Корневой `README.md` (~15): «Accounts: play at once as a guest with a
   system-generated nick; a passkey keeps your rank and skills (no
   passwords, no expiry); global nick via a central auth service, JWT
   identity verified by the host…».
7. Комментарии кода с «OAuth» — `src/dedicated/main.js` (~82, ~570),
   `src/standalone/index.js` (~11), `templates/default/dev/main.js` (~2),
   `client/boot.js` (~4, «лобби за OAuth-гейтом») — по смыслу.
8. `CLAUDE.md` (проект): проверить — стек и команды не менялись
   (`npm run dev:auth / start:auth / auth:db:migrate` остаются); новые
   зависимости `@simplewebauthn/*` — не «core stack», в CLAUDE.md не
   нужны. Если всё же правится — английский, ≤ 1000 токенов.
9. Финальный поиск по репозиторию (с исключением `node_modules`, `plan/`
   и `CHANGELOG.md`): `OAuth|oauth|GitHub OAuth|pendingToken|vimpAuthToken|VIMP_ADMIN_NICKS|VIMP_ADMIN_IDENTITIES|VIMP_AUTH_PUBLIC_URL|GITHUB_CLIENT`
   — каждое оставшееся вхождение объяснимо (выведенные миграции,
   CHANGELOG-история).

## 8.4 `plan/host-migration-smoke.md`

«Подготовка» п. 3 — профили входят через новый dev-логин (участники) или
гостями (для гостей — тестовые ключи Turnstile проходят автоматически);
сценарий 1.2 — «Открыть ссылку в новом профиле → гость, (Turnstile) →
сразу экран авторизации игры в этой комнате».

## 8.5 Порядок выката (в `deployment.md` и для разработчика)

1. **Резервная копия БД auth** на сервере (`pg_dump`) — миграция 017
   необратимо удаляет всех пользователей и их рейтинги (решение Р2).
2. Cloudflare: виджет Turnstile (Managed), домены всех мастеров; ключи.
3. GitHub → Settings → Secrets and variables → Actions: Variables
   `TURNSTILE_SITE_KEY`, `WEBAUTHN_RP_ID` (`vimp.lgick.space`),
   `VIMP_ADMIN_USER_IDS` пока пусто; Secret `TURNSTILE_SECRET`. Variables
   `VIMP_ADMIN_NICKS`, `VIMP_ADMIN_IDENTITIES` — удалить.
4. Nginx каждого мастера: строку CSP обновить вручную (добавить
   `https://challenges.cloudflare.com` в `script-src` и
   `frame-src https://challenges.cloudflare.com`) или перезапустить
   `add-server.sh` для домена — иначе виджет заблокирован CSP статики.
5. Push в `main`: `deploy_auth` (миграции → 017 чистый старт → новый
   сервис) и мастера деплоятся параллельно; минуты рассинхрона (старые
   вкладки с OAuth-токенами без `kind` получают `invalidToken` и после
   перезагрузки становятся гостями) — ожидаемо.
6. Проверка: открыть лобби → ник гостя; «Save progress with a passkey» →
   «Account #N»; записать `N`.
7. Variable `VIMP_ADMIN_USER_IDS=N` → «Re-run jobs» последнего прогона
   `deploy.yml` (или следующий пуш) → в лобби появились «Moderation» и
   «Errors».
8. GitHub OAuth App — удалить (github.com/settings/developers).
9. Порядок релизов npm: `vimp-engine` → `create-vimp-game` (скаффолдер
   пинит текущий движок, `docs/en/publishing.md`); игры — по их правилам.

## 8.6 Ручной smoke (разработчик, dev-контур, затем прод)

| #   | Сценарий                                                                             | Ожидание                                                                      |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1   | Новый профиль браузера открывает лобби                                               | ник гостя без кликов; в БД `users` строк не прибавилось                       |
| 2   | Перезагрузка вкладки                                                                 | ник по ответу У2 (тот же / новый)                                             |
| 3   | Гость: «Create server»                                                               | виджет Turnstile, затем комната; повтор в пределах срока У3 — без виджета     |
| 4   | Гость по ссылке на чужую комнату / быстрая игра                                      | Turnstile (если срок истёк), затем вход                                       |
| 5   | Гость играет, набирает очки, выходит                                                 | в `rank_events` записей нет                                                   |
| 6   | Гость: «Save progress with a passkey»                                                | «Account #N», ник прежний; в БД — `users`, `webauthn_credentials`, `sessions` |
| 7   | Участник играет, набирает очки                                                       | `rank_events` с его `user_id`; место в лобби                                  |
| 8   | Другой профиль: «Sign in with a passkey»                                             | тот же аккаунт и ник                                                          |
| 9   | «Change nick» (Turnstile) на занятый / гостевой шаблон / свободный                   | `nickTaken` / `nickReserved` / новый ник в лобби и лидерборде                 |
| 10  | В комнате: бейджа аккаунта нет; `/name X` в чате                                     | ник не меняется (в tanks/snakes после этапа 7 — «Command not found»)          |
| 11  | Матч дольше `exp` токена (в dev временно `jwt.expiresIn: '3m'`, `renew.leadMs` 60 с) | продление без перерыва; запись очков участника не теряется (`TOKEN_REFRESH`)  |
| 12  | `last_active_at` участника сдвинуть на 31 день, `db:users-purge`                     | аккаунт и рейтинг удалены; вход этим passkey — «No account for this passkey»  |
| 13  | Админ (id в `VIMP_ADMIN_USER_IDS`) с `last_active_at` −31 день                       | не удалён                                                                     |
| 14  | «Sign out» участника                                                                 | новый гость; повторный вход по passkey возвращает аккаунт                     |
| 15  | Миграция хоста гостем без живого `hvUntil` (аварийная, плановая)                     | матч переезжает без Turnstile у гостей (возобновление — не вход)              |
| 16  | Мастер на домене вне rpId (если есть)                                                | кнопки passkey неактивны с подсказкой; гость играет                           |

## Проверки

`npx prettier --write <изменённые файлы>`, `npx eslint .`,
`npx vitest run --reporter=dot`, `npm run test:scaffold`,
`bash -n .github/deployment/add-server.sh`.

## Критерии готовности

- Скрипты деплоя и workflow не знают об OAuth и админах по нику; новые
  переменные и секреты описаны и доезжают до `.env.prod`.
- В документации (en/ru, docs/ai, README) нет старой авторизации; есть
  порядок выката и ручной smoke.
- Все этапы плана помечены «✅ выполнен», план перенесён в
  `plan/done/passkey-auth/` со строкой в `plan/done/README.md`.
- Release impact (итог для разработчика): npm `vimp-engine` — minor
  (⚠️ Breaking); `create-vimp-game` — patch (Removed); auth-сервис —
  деплой с миграцией 017 (чистый старт); `../vimp-tanks`,
  `../vimp-snakes` — `/name` удалён (релиз по их правилам); крейт — нет.
