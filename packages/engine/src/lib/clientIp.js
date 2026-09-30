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
      '[clientIp] trustProxy is on but no X-Real-IP header arrived: every ' +
        "client now keys on the proxy's own address, one shared rate-limit " +
        'bucket. Check `proxy_set_header X-Real-IP $remote_addr`.',
    );
  }

  return String(header || req.socket?.remoteAddress || '').trim();
}

// Ключ rate-limit'а по адресу: IPv4 — сам адрес, IPv6 — подсеть /64.
// Провайдер выдаёт абоненту /64 целиком, то есть у одного человека
// 2^64 адресов, и лимит «на адрес» для IPv6 не лимит вовсе
export function rateLimitKey(ip) {
  const addr = String(ip ?? '').trim();

  if (!addr) {
    return '';
  }

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);

  if (mapped) {
    return mapped[1];
  }

  if (!addr.includes(':')) {
    return addr;
  }

  const groups = expandIpv6(addr.split('%')[0]);

  if (!groups) {
    return addr;
  }

  return `v6:${groups
    .slice(0, 4)
    .map(g => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

// '2001:db8::1' → 8 hex-групп или null, если запись непарсима
function expandIpv6(addr) {
  const halves = addr.split('::');

  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;

  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }

  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];

  return groups.every(g => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : null;
}
