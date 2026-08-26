// Ссылка на проект для футеров лобби и формы входа: движок показывает рядом
// npm-версию, и клик по соседней ячейке ведёт в репозиторий этого пакета.
//
// Источник — `repository` его package.json (иначе `homepage`). Фолбэка нет:
// пакет, не объявивший ни того, ни другого, ссылки не получает, и ячейка
// футера остаётся пустой. Это сознательно — прежний фолбэк на страницу пакета
// в npm давал разнобой («GitHub» у одной игры, «npm» у другой) и молча
// маскировал недостающие метаданные вместо того, чтобы показать их отсутствие.
// О пропущенном поле предупреждает правило контракта A7.
//
// Хостинг не ограничен github.com: подпись выводится из хоста, поэтому чужой
// плагин на GitLab получает честную ссылку, а не пустую ячейку.
//
// Модуль изоморфный: мастер зовёт resolveProjectUrl для пакета игры
// (GameCatalog), клиент — для собственного package.json движка
// (client/lib/engineVersion.js).

/**
 * Адрес проекта из package.json, приведённый к https: repository, иначе
 * homepage.
 * @param {Object} pkg - разобранный package.json
 * @returns {string|null} https-URL либо null, если поля нет или это не адрес
 */
export function resolveProjectUrl(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }

  const { homepage, repository } = pkg;

  // repository бывает и строкой ("github:user/repo"), и объектом {type, url}
  const declared =
    typeof repository === 'string' ? repository : repository?.url;

  // объявленный, но не приводящийся к http(s) repository (пустая строка,
  // внутренний git-хост) не повод терять валидный homepage: поле проверяется
  // по результату, а не по факту наличия
  return normalizeRepository(declared) ?? normalize(homepage);
}

/**
 * Ссылка футера по готовому адресу проекта.
 * @param {string|null} [url] - результат resolveProjectUrl
 * @returns {{url: string, label: string}|null} null, если адреса нет
 */
export function projectLink(url) {
  // адрес перепроверяется, хотя свои вызовы приходят уже из
  // resolveProjectUrl: функция — публичный экспорт ("./lib/*"), а результат
  // уходит прямо в href якоря (client/lib/footerLink.js)
  const value = typeof url === 'string' ? url.trim() : '';

  if (!/^https?:\/\//.test(value)) {
    return null;
  }

  return { url: value, label: labelFor(value) };
}

// шорткат "user/repo" — семантика поля repository (так его читает npm), в
// homepage такая строка означала бы относительный путь, а не адрес на GitHub
function normalizeRepository(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';

  return /^[\w.-]+\/[\w.-]+$/.test(value)
    ? `https://github.com/${value}`
    : normalize(raw);
}

// приводит объявленный адрес к https-виду; всё, что после нормализации не
// http(s) (git@ без известной формы, file:, мусор), адресом не считается
function normalize(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  let url = raw.trim();

  if (!url) {
    return null;
  }

  // npm-шорткаты: "github:user/repo", "gitlab:...", "bitbucket:..."
  const shorthand = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/.exec(url);

  if (shorthand) {
    const hosts = {
      github: 'github.com',
      gitlab: 'gitlab.com',
      bitbucket: 'bitbucket.org',
    };

    return `https://${hosts[shorthand[1]]}/${shorthand[2]}`;
  }

  url = url.replace(/^git\+/, '');

  // scp-форма git@host:user/repo — двоеточие здесь разделитель, не порт
  const scp = /^git@([^:/]+):(.+)$/.exec(url);

  if (scp) {
    url = `https://${scp[1]}/${scp[2]}`;
  }

  url = url
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^ssh:\/\//, 'https://')
    .replace(/^git:\/\//, 'https://');

  if (!/^https?:\/\//.test(url)) {
    return null;
  }

  return (
    url
      // логин (и тем более пароль) из ssh-формы адреса — не часть проекта, а
      // в href он уехал бы в DOM и историю браузера
      .replace(/^(https?:\/\/)[^/@]*@/, '$1')
      .replace(/\.git(?=$|[#?])/, '')
      // npm сам дописывает "#readme" в homepage при генерации package.json
      .replace(/#readme$/, '')
      .replace(/\/+$/, '')
  );
}

// подпись ячейки: у наших пакетов это всегда GitHub, у чужого хостинга —
// его хост, чтобы подпись не врала об источнике
function labelFor(url) {
  let host;

  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Website';
  }

  return host === 'github.com' ? 'GitHub' : host;
}
