// Конфиг клиентского логина лобби (Этап B2). Бандлится в клиентскую сборку,
// как config/lobby.js — auth-сервис живёт на отдельном домене/порте, поэтому
// serviceUrl должен быть подставлен под конкретный деплой перед сборкой прода
// (см. docs/en/auth.md).
export default {
  // базовый URL центрального auth-сервиса (packages/auth). Дефолт — dev-порт
  // из packages/auth/src/config/auth.js; в проде подставляется Vite'ом из
  // VITE_AUTH_SERVICE_URL (см. Dockerfile — тот же VIMP_AUTH_SERVICE_URL,
  // что и серверный master/main.js), никакой ручной правки перед сборкой
  // больше не требуется. Этот модуль импортируется и серверным
  // master/main.js под чистым Node, где import.meta.env не определён —
  // typeof-guard нужен, иначе TypeError роняет мастер на старте (502)
  serviceUrl:
    (typeof import.meta.env !== 'undefined' &&
      import.meta.env.VITE_AUTH_SERVICE_URL) ||
    'http://localhost:3010',

  // включённые провайдеры (должны совпадать с packages/auth config.oauth)
  providers: ['github'],

  // ключ localStorage для identity JWT
  tokenStorageKey: 'vimpAuthToken',

  // issuer, которым central auth-сервис подписывает identity-токен (Этап B3);
  // должен совпадать с packages/auth/src/config/auth.js: jwt.issuer — хост
  // сверяет claim iss токена с этим значением при проверке подписи по /jwks
  issuer: 'vimp-auth',

  // имя query-параметров, которыми auth-сервис возвращает управление
  // (redirect на returnUrl после /oauth/:provider/callback)
  queryParams: {
    token: 'token',
    pendingToken: 'pendingToken',
    error: 'authError',
  },

  // DOM-элементы экрана логина/ника (views/includes/lobbyAuth.pug) и бейджа
  // пользователя в лобби (views/includes/lobby.pug)
  elems: {
    containerId: 'lobby-auth',
    loginSectionId: 'lobby-auth-login',
    loginErrorId: 'lobby-auth-login-error',
    nickSectionId: 'lobby-auth-nick',
    nickInputId: 'lobby-auth-nick-input',
    nickErrorId: 'lobby-auth-nick-error',
    nickSubmitId: 'lobby-auth-nick-submit',
    lobbyId: 'lobby',
    userId: 'lobby-user',
    userNickId: 'lobby-user-nick',
    userLogoutId: 'lobby-user-logout',
  },

  // CSS-класс кнопок провайдеров в lobbyAuth.pug (data-provider на каждой)
  providerButtonClass: 'lobby-auth-provider',
};
