// DEV-ONLY: вход в лобби без OAuth-провайдера. Маршрут регистрируется в
// main.js только при NODE_ENV !== 'production' — в проде его физически нет.
//
// Повторяет хвост GET /oauth/:provider/callback (обмен кодом пропущен):
// находит/создаёт пользователя под provider 'dev' и редиректит на returnUrl
// с identity-токеном, поэтому клиентский путь остаётся штатным —
// LobbyAuthModel.boot() читает ?token= так же, как после реального OAuth.
//
// Зависимости инжектируются (как fetchImpl в движковых прокси мастера) —
// хендлер тестируется без Express и живой БД.
import { NickTakenError } from './UserRepository.js';

export default function createDevLoginHandler({
  userRepo,
  issueIdentityToken,
  isAllowedReturnUrl,
  isValidNick,
}) {
  return async (req, res) => {
    const { nick, returnUrl } = req.query;

    if (!isValidNick(nick)) {
      res.status(400).json({ error: 'invalidNick' });
      return;
    }

    // тот же гейт, что у OAuth-редиректа: в dev allowlist — origin мастера,
    // так что открытого редиректа с валидным токеном не появляется
    if (typeof returnUrl !== 'string' || !isAllowedReturnUrl(returnUrl)) {
      res.status(400).json({ error: 'returnUrlNotAllowed' });
      return;
    }

    // объявлен снаружи try: при отказе catch должен убрать за собой
    // созданную строку пользователя
    let user;

    try {
      // provider_uid = ник: повторный вход тем же ником — тот же пользователь
      // (и тот же sub, значит накопленные rank/state сохраняются)
      user = await userRepo.findOrCreateByProvider('dev', nick);

      if (!user.nick) {
        await userRepo.setNick(user.id, nick);
      }

      const redirectUrl = new URL(returnUrl);

      // тот же выпуск токена, что и у OAuth-колбэка: роль (master-game-registry)
      // синхронизируется с VIMP_ADMIN_NICKS и здесь, иначе локальный вход
      // никогда не дал бы админа
      redirectUrl.searchParams.set('token', await issueIdentityToken({ id: user.id, nick }));

      res.redirect(redirectUrl.toString());
    } catch (err) {
      // ник занят другой личностью (в т.ч. тем же ником в другом регистре:
      // индекс уникальности стоит на lower(nick)). Это отказ входа, а не
      // сбой сервиса, и незаполненная строка пользователя после него
      // остаться не должна — иначе повторный вход тем же ником даёт 500
      if (err instanceof NickTakenError) {
        // отказ уборки ответ клиенту не меняет (вход всё равно отклонён), но
        // молчать о нём нельзя: незаполненная строка останется, и следующий
        // вход тем же ником снова даст 500 — ровно то, что здесь и чинится
        await userRepo
          .deleteIfAnonymous(user?.id)
          .catch(cleanupErr => console.error('[dev login] cleanup', cleanupErr));
        res.status(409).json({ error: 'nickTaken' });
        return;
      }

      console.error('[dev login]', err);
      res.status(500).json({ error: 'devLoginFailed' });
    }
  };
}
