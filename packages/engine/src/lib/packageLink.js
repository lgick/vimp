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
    (typeof repository === 'string' ? repository : repository?.url) ?? homepage;

  return normalize(declared);
}

/**
 * Ссылка футера по готовому адресу проекта.
 * @param {string|null} [url] - результат resolveProjectUrl
 * @returns {{url: string, label: string}|null} null, если адреса нет
 */
export function projectLink(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  return { url, label: labelFor(url) };
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

  // npm-шорткаты: "github:user/repo", "gitlab:...", "bitbucket:...", а также
  // голое "user/repo" — его принимает флаг --repository скаффолдера
  const bare = /^([\w.-]+\/[\w.-]+)$/.exec(url);

  if (bare) {
    return `https://github.com/${bare[1]}`;
  }

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
      .replace(/\.git(?=$|[#?])/, '')
      // npm сам дописывает "#readme" в homepage при генерации package.json
      .replace(/#readme$/, '')
      .replace(/\/+$/, '')
  );
}

// подпись ячейки: у наших пакетов это всегда GitHub, у чужого хостинга —
// его хост, чтобы подпись не врала об источнике
function labelFor(url) {
  if (/^https?:\/\/(www\.)?github\.com\//.test(url)) {
    return 'GitHub';
  }

  const host = /^https?:\/\/(?:www\.)?([^/:]+)/.exec(url);

  return host ? host[1] : 'Website';
}
