import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceMapGenerator } from 'source-map-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createSymbolicator,
  normalizeSource,
} from '../../packages/engine/src/master/clientReports/symbolicate.js';

// Расшифровка стеков журнала клиентских ошибок по скрытым source maps
// (plan/client-reports, этап 4)

const HEAD = "TypeError: Cannot read properties of null (reading 'x')";
const V8_FRAME = '    at Tr (https://h/assets/bundle.js:1:11)';
const DECODED =
  '    at modelLean (src/client/parts/Tank.js:42:5) [/assets/bundle.js:1:11]';

let root;
let outside;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vimp-symbolicate-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vimp-symbolicate-out-'));

  const generator = new SourceMapGenerator({ file: 'bundle.js' });

  generator.addMapping({
    generated: { line: 1, column: 10 },
    original: { line: 42, column: 4 },
    source: '../../src/client/parts/Tank.js',
    name: 'modelLean',
  });

  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'bundle.js'), 'var a=1;Tr();\n');
  await fs.writeFile(path.join(root, 'assets', 'bundle.js.map'), generator.toString());
  // та же карта, но вне корней и у не-js файла
  await fs.writeFile(path.join(outside, 'bundle.js'), 'x');
  await fs.writeFile(path.join(outside, 'bundle.js.map'), generator.toString());
  await fs.writeFile(path.join(root, 'assets', 'data.json.map'), generator.toString());
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const make = (opts = {}) =>
  createSymbolicator({
    roots: [root],
    resolveFile: pathname => path.join(root, pathname),
    ...opts,
  });

describe('createSymbolicator', () => {
  it('V8-кадр → исходное место, первая строка без изменений', async () => {
    const out = await make()([HEAD, V8_FRAME].join('\n'));

    expect(out).toBe([HEAD, DECODED].join('\n'));
  });

  it('Firefox/Safari-кадр → то же', async () => {
    const out = await make()([HEAD, 'Tr@https://h/assets/bundle.js:1:11'].join('\n'));

    expect(out.split('\n')[1]).toBe(DECODED);
  });

  it('кадры после maxFrames остаются сырыми', async () => {
    const out = await make({ maxFrames: 1 })([HEAD, V8_FRAME, V8_FRAME].join('\n'));

    expect(out.split('\n')).toEqual([HEAD, DECODED, V8_FRAME]);
  });

  it('нет карты / blob: / файл не найден → сырой кадр', async () => {
    const frames = [
      '    at f (https://h/assets/nomap.js:1:11)',
      '    at g (blob:https://h/1234-5678:1:11)',
      '    at h (https://other/unknown/x.js:1:11)',
    ];
    const symbolicate = make({
      resolveFile: pathname =>
        pathname.startsWith('/unknown/') ? null : path.join(root, pathname),
    });

    const out = await symbolicate([HEAD, ...frames].join('\n'));

    expect(out).toBe([HEAD, ...frames].join('\n'));
  });

  it('обход через `..` и файл не .js → сырой кадр без чтения диска', async () => {
    const readFile = vi.spyOn(fs, 'readFile');
    const stat = vi.spyOn(fs, 'stat');
    const escape = make({
      resolveFile: () => path.join(root, '..', path.basename(outside), 'bundle.js'),
    });
    const notJs = make({ resolveFile: () => path.join(root, 'assets', 'data.json') });

    expect(await escape([HEAD, V8_FRAME].join('\n'))).toBe([HEAD, V8_FRAME].join('\n'));
    expect(await notJs([HEAD, V8_FRAME].join('\n'))).toBe([HEAD, V8_FRAME].join('\n'));
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('карта больше maxMapBytes → сырой кадр', async () => {
    const out = await make({ maxMapBytes: 10 })([HEAD, V8_FRAME].join('\n'));

    expect(out).toBe([HEAD, V8_FRAME].join('\n'));
  });

  it('LRU: повторный вызов не читает карту с диска', async () => {
    const readFile = vi.spyOn(fs, 'readFile');
    const symbolicate = make();

    await symbolicate([HEAD, V8_FRAME].join('\n'));
    const out = await symbolicate([HEAD, V8_FRAME, V8_FRAME].join('\n'));

    expect(out.split('\n')).toEqual([HEAD, DECODED, DECODED]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('битая карта не ломает остальной стек', async () => {
    await fs.writeFile(path.join(root, 'assets', 'broken.js'), 'x');
    await fs.writeFile(path.join(root, 'assets', 'broken.js.map'), '{not json');

    const broken = '    at b (https://h/assets/broken.js:1:1)';
    const out = await make()([HEAD, broken, V8_FRAME].join('\n'));

    expect(out.split('\n')).toEqual([HEAD, broken, DECODED]);
  });
});

describe('normalizeSource', () => {
  it('срезает префиксы сборщика и оставляет хвост с src/ или node_modules/', () => {
    expect(normalizeSource('../../src/client/a.js')).toBe('src/client/a.js');
    expect(normalizeSource('webpack:///./src/a.js')).toBe('src/a.js');
    expect(normalizeSource('vite://pkg/node_modules/pixi.js/lib/x.mjs')).toBe(
      'node_modules/pixi.js/lib/x.mjs',
    );
    expect(normalizeSource('./lib/a.js')).toBe('lib/a.js');
  });
});
