import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateGame } from '../../../scripts/release/games.js';

let root;

async function makeGame(name, { pkg, cargo }) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });

  if (pkg) {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  }

  if (cargo) {
    await mkdir(path.join(dir, 'core'), { recursive: true });
    await writeFile(path.join(dir, 'core', 'Cargo.toml'), cargo);
  }

  return dir;
}

const validPkg = {
  name: '@vimp-games/tanks',
  version: '0.4.2',
  devDependencies: { 'vimp-engine': '^0.6.0' },
  scripts: { build: 'vite build', 'core:build': 'wasm-pack build core' },
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-release-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateGame', () => {
  it('принимает годный плагин', async () => {
    const dir = await makeGame('good', {
      pkg: validPkg,
      cargo: '[dependencies]\nvimp-engine-core = "0.2.1"\n',
    });

    const info = await validateGame(dir);

    expect(info.valid).toBe(true);
    expect(info.name).toBe('@vimp-games/tanks');
    expect(info.version).toBe('0.4.2');
    expect(info.scripts.build).toBe('vite build');
    // по пину видно, на каком ядре собрана игра (decide → required)
    expect(info.corePin).toBe('0.2.1');
  });

  // форма-таблица (`{ version = "…" }`) шагом B не переписывается, поэтому и
  // отставание по ней не заявляется: иначе план обещал бы починку, которой
  // не будет
  it('не выдумывает пин, которого не умеет переписать', async () => {
    const dir = await makeGame('table-pin', {
      pkg: validPkg,
      cargo: '[dependencies]\nvimp-engine-core = { version = "0.2.1" }\n',
    });

    const info = await validateGame(dir);

    expect(info.valid).toBe(true);
    expect(info.corePin).toBe(null);
  });

  it('отбраковывает плагин без core/Cargo.toml', async () => {
    const dir = await makeGame('no-core', { pkg: validPkg });
    const info = await validateGame(dir);

    expect(info.valid).toBe(false);
    expect(info.problems).toContain('нет core/Cargo.toml');
  });

  it('отбраковывает Cargo.toml без vimp-engine-core', async () => {
    const dir = await makeGame('no-dep', {
      pkg: validPkg,
      cargo: '[dependencies]\nrapier2d = "0.2"\n',
    });

    expect((await validateGame(dir)).problems).toContain(
      'core/Cargo.toml не зависит от vimp-engine-core',
    );
  });

  it('отбраковывает чужой пакет', async () => {
    const dir = await makeGame('stranger', {
      pkg: { name: 'some-lib', version: '1.0.0' },
      cargo: '[dependencies]\nvimp-engine-core = "0.2.1"\n',
    });

    const info = await validateGame(dir);

    expect(info.valid).toBe(false);
    expect(info.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('вне scope'),
        'vimp-engine отсутствует в зависимостях',
      ]),
    );
  });

  // без этой проверки план дошёл бы до `git tag vnull` — после сборки,
  // проверок тарбола и коммита
  it('отбраковывает пакет без version', async () => {
    const dir = await makeGame('no-version', {
      pkg: { ...validPkg, version: undefined },
      cargo: '[dependencies]\nvimp-engine-core = "0.2.1"\n',
    });

    const info = await validateGame(dir);

    expect(info.valid).toBe(false);
    expect(info.problems).toContain('version=— не вида X.Y.Z');
  });

  // пререлизы semver.js намеренно не поддерживает: compareVersions бросил бы
  // голое «not a semver version» посреди планирования
  it('отбраковывает пререлизную версию', async () => {
    const dir = await makeGame('prerelease', {
      pkg: { ...validPkg, version: '0.5.0-rc.1' },
      cargo: '[dependencies]\nvimp-engine-core = "0.2.1"\n',
    });

    const info = await validateGame(dir);

    expect(info.valid).toBe(false);
    expect(info.problems).toContain('version=0.5.0-rc.1 не вида X.Y.Z');
  });

  it('отбраковывает каталог без package.json', async () => {
    const dir = await makeGame('empty', {});

    expect(await validateGame(dir)).toMatchObject({
      valid: false,
      problems: ['нет package.json'],
    });
  });
});
