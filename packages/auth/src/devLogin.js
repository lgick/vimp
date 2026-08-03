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
export default function createDevLoginHandler({
  userRepo,
  jwtLib,
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

    try {
      // provider_uid = ник: повторный вход тем же ником — тот же пользователь
      // (и тот же sub, значит накопленные rank/state сохраняются)
      const user = await userRepo.findOrCreateByProvider('dev', nick);

      if (!user.nick) {
        await userRepo.setNick(user.id, nick);
      }

      const redirectUrl = new URL(returnUrl);

      redirectUrl.searchParams.set(
        'token',
        jwtLib.signIdentityToken({ sub: user.id, nick }),
      );

      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error('[dev login]', err);
      res.status(500).json({ error: 'devLoginFailed' });
    }
  };
}
