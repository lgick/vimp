import { describe, it, expect } from 'vitest';
import {
  homepageOf,
  resolvePackageLink,
} from '../../packages/engine/src/lib/packageLink.js';

// Ссылка футеров лобби и формы входа: адрес проекта из package.json пакета,
// приведённый к https, с фолбэком на страницу пакета в npm (её достаточно
// одного имени, поэтому рабочая ссылка есть всегда).

const link = pkg => resolvePackageLink({ name: pkg.name, homepage: homepageOf(pkg) });

describe('homepageOf', () => {
  it('предпочитает homepage репозиторию', () => {
    expect(
      homepageOf({
        homepage: 'https://example.com',
        repository: { url: 'git+ssh://git@github.com/a/b.git' },
      }),
    ).toBe('https://example.com');
  });

  it('берёт repository объектом и строкой', () => {
    expect(homepageOf({ repository: { url: 'git://github.com/a/b' } })).toBe(
      'git://github.com/a/b',
    );
    expect(homepageOf({ repository: 'github:a/b' })).toBe('github:a/b');
  });

  it('без обоих полей — null', () => {
    expect(homepageOf({ name: 'x' })).toBe(null);
    expect(homepageOf(null)).toBe(null);
  });

  it('пустой homepage не считается объявленным', () => {
    expect(homepageOf({ homepage: '   ', repository: 'github:a/b' })).toBe(
      'github:a/b',
    );
  });
});

describe('resolvePackageLink: нормализация адреса', () => {
  it('git+ssh с хвостом .git — реальный вид repository у пакетов vimp', () => {
    expect(
      link({
        name: 'vimp-engine',
        repository: { type: 'git', url: 'git+ssh://git@github.com/lgick/vimp.git' },
      }),
    ).toEqual({ url: 'https://github.com/lgick/vimp', label: 'GitHub' });
  });

  it('срезает якорь #readme, который npm дописывает в homepage', () => {
    expect(link({ name: 'x', homepage: 'https://github.com/lgick/vimp-tanks#readme' })).toEqual(
      { url: 'https://github.com/lgick/vimp-tanks', label: 'GitHub' },
    );
  });

  it('git+https, git:// и scp-форма git@host:a/b', () => {
    const url = 'https://github.com/a/b';

    expect(link({ name: 'x', repository: 'git+https://github.com/a/b.git' }).url).toBe(url);
    expect(link({ name: 'x', repository: 'git://github.com/a/b' }).url).toBe(url);
    expect(link({ name: 'x', repository: { url: 'git@github.com:a/b.git' } }).url).toBe(url);
  });

  it('шорткаты github:/gitlab:/bitbucket:', () => {
    expect(link({ name: 'x', repository: 'github:a/b' }).url).toBe('https://github.com/a/b');
    expect(link({ name: 'x', repository: 'gitlab:a/b' }).url).toBe('https://gitlab.com/a/b');
    expect(link({ name: 'x', repository: 'bitbucket:a/b' }).url).toBe(
      'https://bitbucket.org/a/b',
    );
  });

  it('снимает завершающий слэш', () => {
    expect(link({ name: 'x', homepage: 'https://example.com/game/' }).url).toBe(
      'https://example.com/game',
    );
  });
});

describe('resolvePackageLink: фолбэк и подпись', () => {
  it('пакет без метаданных ведёт на свою страницу в npm', () => {
    expect(link({ name: '@vimp-games/snakes' })).toEqual({
      url: 'https://www.npmjs.com/package/@vimp-games/snakes',
      label: 'npm',
    });
  });

  it('адрес, который не приводится к http(s), уходит в тот же фолбэк', () => {
    expect(link({ name: 'x', homepage: 'not a url' }).label).toBe('npm');
    expect(link({ name: 'x', homepage: 'file:///tmp/repo' }).label).toBe('npm');
  });

  it('не-github хост подписывается нейтрально', () => {
    expect(link({ name: 'x', homepage: 'https://gitlab.com/a/b' }).label).toBe('Website');
  });

  it('без имени и без адреса ссылки нет вовсе', () => {
    expect(resolvePackageLink({})).toBe(null);
    expect(resolvePackageLink(null)).toBe(null);
    expect(resolvePackageLink({ name: '  ' })).toBe(null);
  });
});
