// Ссылка на пакет для футеров лобби и формы входа: движок показывает рядом
// npm-версию, и клик по соседней ячейке должен вести на страницу этого пакета.
//
// Источник — `homepage`/`repository` его package.json, но объявлены они не у
// всех (у @vimp-games/snakes нет ни того, ни другого), а footer без ссылки
// выглядит поломкой. Поэтому фолбэк — страница пакета на npm: она выводится из
// одного лишь имени, то есть существует всегда, и сама ведёт на репозиторий,
// если он объявлен.
//
// Модуль изоморфный: мастер зовёт homepageOf для пакета игры (GameCatalog),
// клиент — для собственного package.json движка (client/lib/engineVersion.js).

const NPM_PACKAGE_BASE = 'https://www.npmjs.com/package/';

/**
 * Сырой адрес проекта из package.json: homepage, иначе repository.
 * @param {Object} pkg - разобранный package.json
 * @returns {string|null} адрес как объявлен (нормализует resolvePackageLink)
 */
export function homepageOf(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }

  const { homepage, repository } = pkg;

  if (typeof homepage === 'string' && homepage.trim()) {
    return homepage;
  }

  // repository бывает и строкой ("github:user/repo"), и объектом {type, url}
  if (typeof repository === 'string') {
    return repository;
  }

  if (repository && typeof repository.url === 'string') {
    return repository.url;
  }

  return null;
}

/**
 * Ссылка футера по метаданным пакета.
 * @param {{name?: string, homepage?: string}} [pkg] - имя пакета и сырой homepage
 * @returns {{url: string, label: string}|null} null, если нет даже имени
 */
export function resolvePackageLink(pkg) {
  const { name, homepage } = pkg ?? {};
  const declared = normalize(homepage);

  if (declared) {
    return { url: declared, label: labelFor(declared) };
  }

  if (typeof name === 'string' && name.trim()) {
    return { url: `${NPM_PACKAGE_BASE}${name.trim()}`, label: 'npm' };
  }

  return null;
}

// приводит объявленный адрес к https-виду; всё, что после нормализации не
// http(s) (git@ без известной формы, file:, мусор), — не ссылка, а фолбэк
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
      .replace(/\.git(?=$|[#?])/, '')
      // npm сам дописывает "#readme" в homepage при генерации package.json
      .replace(/#readme$/, '')
      .replace(/\/+$/, '')
  );
}

function labelFor(url) {
  if (/^https?:\/\/(www\.)?github\.com\//.test(url)) {
    return 'GitHub';
  }

  if (url.startsWith(NPM_PACKAGE_BASE)) {
    return 'npm';
  }

  return 'Website';
}
