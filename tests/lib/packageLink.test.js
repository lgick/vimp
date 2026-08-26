import { describe, it, expect } from 'vitest';
import {
  projectLink,
  resolveProjectUrl,
} from '../../packages/engine/src/lib/packageLink.js';

// Ссылка футеров лобби и формы входа: адрес репозитория из package.json
// пакета, приведённый к https. Фолбэка нет — пакет без метаданных ссылки не
// получает, и об этом предупреждает правило контракта A7.

const link = pkg => projectLink(resolveProjectUrl(pkg));

describe('resolveProjectUrl: выбор поля', () => {
  it('repository важнее homepage — ссылка ведёт в репозиторий, не на лендинг', () => {
    expect(
      resolveProjectUrl({
        repository: { url: 'git+ssh://git@github.com/a/b.git' },
        homepage: 'https://example.com/landing',
      }),
    ).toBe('https://github.com/a/b');
  });

  it('homepage подхватывается, когда repository не объявлен', () => {
    expect(resolveProjectUrl({ homepage: 'https://github.com/x/y' })).toBe(
      'https://github.com/x/y',
    );
  });

  it('без обоих полей — null', () => {
    expect(resolveProjectUrl({ name: '@vimp-games/snakes' })).toBe(null);
    expect(resolveProjectUrl(null)).toBe(null);
  });

  // «иначе homepage» — про результат, а не про факт наличия поля: repository
  // бывает объявлен пустым или ведёт на хост, которого в вебе нет
  it('repository, который ни во что не разрешается, отдаёт ход homepage', () => {
    const homepage = 'https://github.com/a/b';

    expect(resolveProjectUrl({ repository: '', homepage })).toBe(homepage);
    expect(resolveProjectUrl({ repository: { url: '  ' }, homepage })).toBe(
      homepage,
    );
    expect(
      resolveProjectUrl({ repository: { url: 'file:///srv/git/x.git' }, homepage }),
    ).toBe(homepage);
  });
});

describe('resolveProjectUrl: нормализация адреса', () => {
  it('git+ssh с хвостом .git — реальный вид repository у пакетов vimp', () => {
    expect(
      resolveProjectUrl({
        repository: { type: 'git', url: 'git+ssh://git@github.com/lgick/vimp.git' },
      }),
    ).toBe('https://github.com/lgick/vimp');
  });

  it('срезает якорь #readme, который npm дописывает в homepage', () => {
    expect(
      resolveProjectUrl({ homepage: 'https://github.com/lgick/vimp-tanks#readme' }),
    ).toBe('https://github.com/lgick/vimp-tanks');
  });

  it('git+https, git:// и scp-форма git@host:a/b', () => {
    const url = 'https://github.com/a/b';

    expect(resolveProjectUrl({ repository: 'git+https://github.com/a/b.git' })).toBe(url);
    expect(resolveProjectUrl({ repository: 'git://github.com/a/b' })).toBe(url);
    expect(resolveProjectUrl({ repository: { url: 'git@github.com:a/b.git' } })).toBe(url);
  });

  it('шорткаты github:/gitlab:/bitbucket:', () => {
    expect(resolveProjectUrl({ repository: 'github:a/b' })).toBe('https://github.com/a/b');
    expect(resolveProjectUrl({ repository: 'gitlab:a/b' })).toBe('https://gitlab.com/a/b');
    expect(resolveProjectUrl({ repository: 'bitbucket:a/b' })).toBe(
      'https://bitbucket.org/a/b',
    );
  });

  it('голое user/repo — шорткат repository, как его читает npm', () => {
    expect(resolveProjectUrl({ repository: 'lgick/vimp-snakes' })).toBe(
      'https://github.com/lgick/vimp-snakes',
    );
  });

  // в homepage та же строка — относительный путь, и раскрытие в github.com
  // отправило бы игроков по заведомо битому адресу
  it('в homepage user/repo шорткатом не считается', () => {
    expect(resolveProjectUrl({ homepage: 'docs/index.html' })).toBe(null);
    expect(resolveProjectUrl({ homepage: './readme' })).toBe(null);
  });

  it('срезает логин из ssh-формы: в href ему не место', () => {
    expect(
      resolveProjectUrl({ repository: 'ssh://someone@git.company.com/team/repo.git' }),
    ).toBe('https://git.company.com/team/repo');
  });

  it('снимает завершающий слэш', () => {
    expect(resolveProjectUrl({ homepage: 'https://example.com/game/' })).toBe(
      'https://example.com/game',
    );
  });

  it('то, что не приводится к http(s), адресом не считается', () => {
    expect(resolveProjectUrl({ homepage: 'not a url' })).toBe(null);
    expect(resolveProjectUrl({ homepage: 'file:///tmp/repo' })).toBe(null);
  });
});

describe('projectLink: подпись ячейки', () => {
  it('github.com подписывается GitHub', () => {
    expect(link({ repository: 'github:lgick/vimp' })).toEqual({
      url: 'https://github.com/lgick/vimp',
      label: 'GitHub',
    });
  });

  it('чужой хостинг подписывается своим хостом, а не отбрасывается', () => {
    expect(link({ repository: 'git@gitlab.com:a/b.git' })).toEqual({
      url: 'https://gitlab.com/a/b',
      label: 'gitlab.com',
    });
  });

  it('порт в подпись не попадает', () => {
    expect(projectLink('https://git.company.com:8443/team/repo').label).toBe(
      'git.company.com',
    );
  });

  it('без адреса ссылки нет — npm-фолбэка больше не существует', () => {
    expect(link({ name: '@vimp-games/snakes' })).toBe(null);
    expect(projectLink(null)).toBe(null);
    expect(projectLink('   ')).toBe(null);
  });

  // публичный экспорт: результат уходит прямо в href якоря, поэтому адрес
  // перепроверяется здесь, а не только на стороне resolveProjectUrl
  it('не-http(s) вход отвергается, а не уезжает в href', () => {
    expect(projectLink('javascript:alert(1)')).toBe(null);
    expect(projectLink('file:///tmp/repo')).toBe(null);
    expect(projectLink('github.com/a/b')).toBe(null);
  });
});
