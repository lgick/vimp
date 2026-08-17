// Адрес клиента для rate-limit'ов серверных контуров.
//
// `X-Forwarded-For` для этого не годится: Nginx деплоя ставит его через
// `$proxy_add_x_forwarded_for` (.github/deployment/install-system.sh), то есть
// ДОПИСЫВАЕТ реальный адрес к тому, что прислал клиент. Первый элемент списка
// задаёт сам клиент — на нём лимит и обходится (свой заголовок на каждое
// соединение), и выбирается чужой бакет (заголовок с адресом жертвы закрывает
// ей вход). Тот же Nginx перезаписывает `X-Real-IP` значением `$remote_addr`,
// поэтому за прокси доверяем только ему, а без прокси — адресу сокета.

// один раз на процесс: предупреждение о прокси без X-Real-IP на каждое
// соединение превратилось бы в лог-флуд
let proxyHeaderWarned = false;

/**
 * @param {Object} req - Запрос (http.IncomingMessage или express Request).
 * @param {Object} [options]
 * @param {boolean} [options.trustProxy] - Стоит ли перед процессом обратный
 *   прокси, перезаписывающий `X-Real-IP` (в этом репозитории — прод-Nginx).
 * @returns {string} Адрес клиента или '' (сокет уже разорван).
 */
export function clientIp(req, { trustProxy = false } = {}) {
  const header = trustProxy ? req.headers['x-real-ip'] : undefined;

  // за прокси без X-Real-IP ключом станет адрес самого прокси — один общий
  // бакет на всех клиентов сразу: правило «одна комната на IP» пустило бы
  // одну комнату на весь мастер, а лимит пингов стал бы общим. Падать на
  // первом запросе нельзя (сервер должен подняться), молчать — тоже
  if (trustProxy && !header && !proxyHeaderWarned) {
    proxyHeaderWarned = true;
    console.warn(
      '[clientIp] trustProxy включён, но X-Real-IP не пришёл: ключ ' +
        "rate-limit'ов стал адресом прокси, общим для всех клиентов. " +
        'Проверьте proxy_set_header X-Real-IP $remote_addr.',
    );
  }

  return String(header || req.socket?.remoteAddress || '').trim();
}
