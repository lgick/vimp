# Этап 10. Голосование «Change host» через мастер ✅ выполнен

Цель: прямая замена `/like`·`/unlike` — игроки большинством голосов снимают
хоста (тролль, читер, просто плохой хост). Голоса считает **мастер**, не
хост: хост физически исполняет матч и мог бы отфильтровать голосование
против себя в своём `CommandProcessor`/`Vote` (та же причина, по которой
`/like` шёл мимо хоста).

Зависит от этапа 8 (плановая передача) и этапа 7 (принудительная миграция).

**Запуск — только чат-командой `/changehost`** (без параметров). Пункта в
меню голосований (клавиша `M` в tanks) **нет** — решение разработчика.
Меню голосований движок не трогает вовсе; окно с вопросом «Change host?»
у остальных гостей показывается тем же компонентом голосования
(`VoteModel.createVote`), но это не пункт меню.

**Только лобби-режим** (P2P-комната через мастер). В **dedicated-сервере**
(`src/dedicated/`) и в **Standalone SDK** (`src/standalone/`, режим `solo`)
`/changehost` не перехватывается: хост там один по определению и мастера,
который считал бы голоса, нет. Режим брать из `boot` (`boot.js`:
`lobby`/`solo`/`dedicated`) — тот же признак, что уже разводит бутстрап в
`main.js:2487-2519`.

## Решения при исполнении (разработчик, 2026-10-03)

- **Отмена** (началась миграция хоста или `eligible` опустело): мастер шлёт
  всем участникам `host_vote_result {passed: false, cancelled: true}`;
  окно «Change host?» закрывается (или снимается из очереди), в чат —
  «Host vote cancelled».
- **Ушедшие**: участник, покинувший комнату (`leave_room` / истёк grace),
  удаляется из `eligible` и из голосов; порог — строгое большинство от
  текущего размера `eligible`, исход перепроверяется; опустело — отмена.
- **Наложение**: в обе стороны очередь — «Change host?» ждёт закрытия
  открытого голосования, голосование хоста ждёт закрытия «Change host?»;
  меню по `M` открывается поверх, как и прежде (действие самого игрока).
- **Время окна**: `host_vote` несёт ещё `durationMs`; клиент показывает окно
  на остаток времени голосования (из очереди — на остаток), по
  `host_vote_result` окно закрывается.
- **Тексты чата — кодами** (правило разработчика из этапа 7c): локальные
  сообщения команды и итога — движковые коды группы `v` (`v:6`…), тексты —
  в обеих играх, шаблоне скаффолдера и фикстуре miniGame; правило `B8`
  резервирует новые индексы.

- **Инициатору — «Voting has started»** (как у голосований хоста, решение
  разработчика после исполнения): мастер шлёт ему `host_vote_started`,
  клиент печатает код `v:1`.
- **Ответившему — «Your vote has been accepted»** (решение разработчика
  после исполнения): на каждый засчитанный `host_vote_answer` (и смену
  ответа) мастер шлёт `host_vote_accepted`, клиент печатает код `v:2`.
- **Правило `B9`** (решение разработчика после исполнения) отвергает шаблон
  или пункт меню голосования с именем на `@`.

### Решения по ревью (разработчик, 2026-10-03)

- **Снятие помнит мастер**: прошедшее голосование ставит
  `room.votedOutEpoch = epoch`. Любая плановая передача хоста этой эпохи
  на мастере идёт с причиной `vote` (причине от клиента не верим), её срыв
  ведёт к принудительной миграции. Клиент на `request_handoff('vote')` при
  отложенной передаче ускоряет её (`hurry('vote')`), а не игнорирует.
- **Принять некому — хост остаётся**: принудительное снятие не делается,
  если кандидатов (или людей) нет; комната не закрывается, отметка
  снятия остаётся.
- **Запрет — по `userId`**: `room.demotedUsers: Map<userId, until>`, любая
  вкладка пользователя в этой комнате (и после перезагрузки) не
  преемник и не хост; аварийное исключение «больше некому» остаётся.
- **CHANGELOG**: резерв `v:6`–`v:15` (B8) и имён на `@` (B9) — `⚠️ Breaking`
  - `Migration` (буква правила CLAUDE.md: контракт отвергает ранее
    проходившую игру).

## 10.1. Мастер: `master/HostVoteManager.js`

Состояние на комнату: активное голосование `{voteId, initiatorMemberId,
eligible: Set<memberId>, yes: Set, no: Set, endsAt}`, `lastVoteAt`,
`lastStartByUser: Map<userId, ts>`.

- `host_vote_start {roomId}` — от участника комнаты (проверенный `userId`
  есть с этапа 2), не текущего хоста; нет активного голосования; с прошлого
  голосования в комнате ≥ `roomVoteCooldownMs` (120000); этот `userId`
  запускал ≥ `userStartCooldownMs` (60000) назад; в комнате есть хотя бы
  один способный преемник (иначе снимать хоста некуда → `error {code:
'noSuccessor'}`). Ошибки — `error {code: 'voteRejected', reason}`.
- `eligible` — живые участники-люди, кроме хоста, на момент старта;
  инициатор сразу «за». Рассылка `host_vote {roomId, voteId,
initiatorNick, endsAt, eligibleCount}` всем `eligible` (кроме
  инициатора) — хосту не шлётся.
- `host_vote_answer {roomId, voteId, value: 'yes'|'no'}` — только от
  `eligible`, один голос (повтор меняет мнение).
- Решение: «за» > `eligibleCount / 2` (строгое большинство); досрочно,
  как только исход определён; иначе по `endsAt`
  (`hostVoteDurationMs`, 15000; молчание = «против»). Комната из хоста и
  одного гостя: большинство = голос гостя — допустимо, защита — кулдауны и
  `demotedUntil`.
- Итог всем участникам: `host_vote_result {roomId, voteId, passed, yes,
no}`.
- `passed` → бывшему хосту `demotedUntil = now + demotedCooldownMs`
  (600000: не может быть ни бетой, ни хостом этой комнаты — фильтр в
  `pickSuccessor`, этап 6; при холодном фолбэке, если других способных
  нет, — исключение снимается, комната важнее); хосту `request_handoff
{reason: 'vote', defer: false}` → `startPlannedHandoff({reason:
'vote', stay: true})`; не начал передачу за `voteForceAfterMs` (5000)
  или передача сорвалась → **принудительно**: `host_revoked` + промоушен
  беты из её последней точки (аварийный путь этапа 7, причина `vote`).
- Голосование отменяется, если ушёл хост (началась миграция) или
  инициатор ушёл и `eligible` опустело.

## 10.2. Клиент: чат-команда `/changehost`

`client/main.js` → `handleChatSend` (где этап 1 убрал перехват `/like`):
в лобби-режиме `/changehost` (ровно команда, без аргументов; с аргументами
— подсказка «Usage: /changehost») не уходит хосту:

- гость → `signaling.send({type: 'host_vote_start', roomId})`;
- хост → локальное сообщение «You are the host — use “Hand over host” in
  the room menu»;
- не залогинен/нет сигналинга → «No connection to the master server»;
- ошибка мастера (`voteRejected` с причиной, `noSuccessor`) → локальное
  сообщение в чат с причиной («A host vote was held recently», «No other
  player can host»).

В режимах `solo`/`dedicated` перехвата нет — команда уходит хосту как
обычный текст и обрабатывается (или нет) игрой. Решение «перехватывать
ли» вынести в чистую функцию (`client/lib/hostVoteCommand.js`:
`shouldInterceptChangeHost(text, bootMode)`). Имя `/changehost` —
зарезервировано движком в лобби-режиме: записать в `plugin-api.md` и
`docs/ai/03-host-plugin.md` (раздел чат-команд), чтобы игра не объявляла
свою с тем же именем.

## 10.3. Клиент: окно голосования у остальных гостей

- Входящий `host_vote` → `voteModel.createVote('@changeHost', 'Change host?
(started by <nick>)', ['Yes', 'No'], false)` (`components/model/Vote.js`;
  меню `data.menu` не трогаем). Ответ из модели (`publisher.emit('socket',
[name, value])`, `Vote.js:155-190`) с именем `@changeHost`
  перехватывается до отправки хосту (там, где `main.js` подписан на
  `socket` модели голосования) → `host_vote_answer`. Префикс `@` в имени
  голосования зарезервирован движком — задокументировать для авторов игр.
- Если в этот момент открыто голосование хоста — проверить, как
  `VoteModel` ведёт себя при наложении; поставить «Change host?» после
  текущего (очередь на клиенте), а не затирать.
- `host_vote_result` → системное сообщение в чат (локально): «Vote to
  change host passed (3/4)» / «failed».

## 10.4. Конфиг

`config/master.js` (`room.vote.*`): `hostVoteDurationMs`,
`roomVoteCooldownMs`, `userStartCooldownMs`, `voteForceAfterMs`,
`demotedCooldownMs`. Доки `configuration.md`.

## 10.5. Тесты

- `tests/master/HostVoteManager.test.js` — старт (хост не может, кулдауны
  комнаты и пользователя, нет преемника), рассылка без хоста, ответы
  только от `eligible`, смена мнения, досрочный исход, таймаут,
  комната 1+1, `demotedUntil` влияет на `pickSuccessor`, принудительная
  миграция по `voteForceAfterMs`, отмена при миграции.
- `tests/client/lib/hostVoteCommand.test.js` — перехват `/changehost` в
  лобби, отсутствие перехвата в `solo`/`dedicated`, команда с аргументами.
- `tests/client/VoteModel.test.js` — голосование `@changeHost` из
  `host_vote`, перехват ответа, очередь при наложении с голосованием хоста;
  меню голосований (`data.menu`) не изменилось ни в одном режиме.

## 10.6. Документация

`docs/{en,ru}/master.md` — раздел «Change host vote» (на месте бывшего
«Server rating»), раздел «Protection»: защита от плохого хоста —
автотриггеры и голосование, оба только в лобби-режиме; `client.md` —
команда `/changehost` и окно голосования (только лобби); `host.md` — «Host
migration» → «Vote»; `network.md` — голосование идёт мимо хоста;
`plugin-api.md`, `docs/ai/03-host-plugin.md`, `docs/ai/04-client-plugin.md`
(зарезервированы `/changehost` и префикс `@` в именах голосований),
`docs/ai/10-pitfalls.md`.

## 10.7. CHANGELOG

`### Added`: «Change host» vote in lobby rooms — started with
`/changehost`, counted by the master (the host cannot block it); a passed
vote hands the host role over and bars the old host from it for 10 minutes.
Not available in dedicated or standalone mode.

## Проверка

Автотесты зелёные. Вручную (3 профиля): гость пишет `/changehost` → у
второго гостя окно «Change host?», у хоста — нет; оба «за» → хост передан,
бывший хост не становится бетой 10 минут; хост пишет `/changehost` →
подсказка; в меню голосований (`M` в tanks) нового пункта нет ни в одном
режиме; в standalone (`startStandaloneGame`) и в dedicated
(`npm run dedicated`) `/changehost` не перехватывается.

## Готово, когда

Проверки зелёные, доки en/ru/ai синхронны, CHANGELOG обновлён, release
impact в отчёте.
