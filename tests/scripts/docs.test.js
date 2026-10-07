import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Страж документации: ссылки с якорями, паритет docs/en ↔ docs/ru, числа из
// кода и версия крейта (по ним docs/ уже расходился с кодом, пока проверки
// были разовыми)
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DIRS = ['en', 'ru', 'ai'];

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const listDocs = dir =>
  fs
    .readdirSync(path.join(ROOT, 'docs', dir))
    .filter(name => name.endsWith('.md'))
    .sort();

// строки вне код-блоков (``` или ~~~; закрывает та же метка не короче открывающей)
const proseLines = text => {
  const out = [];
  let fence = null;

  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);

    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
      }
    } else if (m) {
      fence = m[1];
    } else {
      out.push(line);
    }
  }

  return out;
};

const countFences = text => {
  let count = 0;
  let fence = null;

  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);

    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
      }
    } else if (m) {
      fence = m[1];
      count += 1;
    }
  }

  return count;
};

// якорь заголовка по правилам GitHub; повтор получает суффикс -1, -2
const anchorsOf = text => {
  const seen = new Map();
  const anchors = new Set();

  for (const line of proseLines(text)) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);

    if (!m) {
      continue;
    }

    const base = m[1]
      .trim()
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;

    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }

  return anchors;
};

const safeDecode = s => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const anchorCache = new Map();
const anchorsFor = file => {
  if (!anchorCache.has(file)) {
    anchorCache.set(file, anchorsOf(fs.readFileSync(file, 'utf8')));
  }

  return anchorCache.get(file);
};

describe('docs: ссылки', () => {
  it('каждая относительная ссылка и якорь указывают на существующее место', () => {
    const broken = [];

    for (const dir of DIRS) {
      for (const name of listDocs(dir)) {
        const file = path.join(ROOT, 'docs', dir, name);
        const label = `docs/${dir}/${name}`;

        for (const rawLine of proseLines(fs.readFileSync(file, 'utf8'))) {
          // inline-код не парсим: в нём `[...]` — не ссылки
          const line = rawLine.replace(/`[^`]*`/g, '``');

          for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = m[1];

            // регулярка-шаблон из plugin-api.md и внешние адреса — не ссылки
            if (/^(https?:|mailto:)/.test(target) || /[\\{]/.test(target)) {
              continue;
            }

            const [rel, hash] = target.split('#');
            const dest = rel ? path.resolve(path.dirname(file), rel) : file;

            if (!fs.existsSync(dest)) {
              broken.push(`${label}: нет файла ${target}`);
              continue;
            }

            if (hash && dest.endsWith('.md')) {
              if (!anchorsFor(dest).has(safeDecode(hash).toLowerCase())) {
                broken.push(`${label}: нет якоря ${target}`);
              }
            }
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

describe('docs: паритет en ↔ ru', () => {
  it('наборы страниц совпадают', () => {
    expect(listDocs('ru')).toEqual(listDocs('en'));
  });

  it('у пары страниц совпадают заголовки, строки таблиц, код-блоки и чек-листы', () => {
    const shape = text => {
      const lines = proseLines(text);

      return {
        headings: lines.filter(l => /^#{1,6}\s/.test(l)).length,
        tableRows: lines.filter(l => /^\|/.test(l)).length,
        codeBlocks: countFences(text),
        checkboxes: lines.filter(l => /^\s*- \[[ x]\]/.test(l)).length,
      };
    };
    const diff = [];

    for (const name of listDocs('en')) {
      const en = shape(read(`docs/en/${name}`));
      const ru = shape(read(`docs/ru/${name}`));

      if (JSON.stringify(en) !== JSON.stringify(ru)) {
        diff.push(
          `${name}: en ${JSON.stringify(en)} ≠ ru ${JSON.stringify(ru)}`,
        );
      }
    }

    expect(diff).toEqual([]);
  });
});

describe('docs: числа из кода', () => {
  const grab = (rel, re) => {
    const m = re.exec(read(rel));

    if (!m) {
      throw new Error(`${rel}: не найдено ${re}`);
    }

    return Number(m[1]);
  };

  const constants = {
    ENGINE_API_VERSION: grab(
      'packages/engine/src/config/opcodes.js',
      /ENGINE_API_VERSION = (\d+)/,
    ),
    SNAPSHOT_FORMAT_VERSION: grab(
      'packages/engine/src/config/opcodes.js',
      /SNAPSHOT_FORMAT_VERSION = (\d+)/,
    ),
    HANDOFF_VERSION: grab(
      'packages/engine/src/host/HostGame.js',
      /HANDOFF_VERSION = (\d+)/,
    ),
    PLAYER_STATE_LEN: grab(
      'packages/engine/core/src/config.rs',
      /PLAYER_STATE_LEN: usize = (\d+)/,
    ),
    WORLD_VOICE_LIMIT: grab(
      'packages/engine/src/client/SoundManager.js',
      /WORLD_VOICE_LIMIT = (\d+)/,
    ),
  };

  const allDocs = DIRS.flatMap(dir =>
    listDocs(dir).map(name => ({
      label: `docs/${dir}/${name}`,
      text: read(`docs/${dir}/${name}`),
    })),
  );

  const stale = (re, expected) => {
    const bad = [];

    for (const { label, text } of allDocs) {
      for (const m of text.matchAll(re)) {
        if (Number(m[1]) !== expected) {
          bad.push(`${label}: ${m[0]} (в коде ${expected})`);
        }
      }
    }

    return bad;
  };

  it.each([
    'ENGINE_API_VERSION',
    'SNAPSHOT_FORMAT_VERSION',
    'PLAYER_STATE_LEN',
    'WORLD_VOICE_LIMIT',
    'HANDOFF_VERSION',
  ])('%s в доках равен значению в коде', name => {
    expect(
      stale(new RegExp(`${name}\`? ?(?:=|:) ?\`?(\\d+)`, 'g'), constants[name]),
    ).toEqual([]);
  });

  it('"engineApi": N в примерах манифеста', () => {
    expect(stale(/"engineApi": ?(\d+)/g, constants.ENGINE_API_VERSION)).toEqual(
      [],
    );
  });

  it('версия кадра снапшота (vN) в заголовках и ToC', () => {
    expect(
      stale(
        /(?:snapshot frame|Frame layout|снапшот-кадр\w*|Раскладка кадра) \(v(\d+)\)/gi,
        constants.SNAPSHOT_FORMAT_VERSION,
      ),
    ).toEqual([]);
  });
});

describe('docs: версия крейта', () => {
  it('vimp-engine-core = "X.Y" в core.md совпадает с Cargo.toml', () => {
    const cargo = /^version = "(\d+)\.(\d+)\.\d+"/m.exec(
      read('packages/engine/core/Cargo.toml'),
    );
    const expected = `${cargo[1]}.${cargo[2]}`;

    // расхождение после релиза крейта — сигнал обновить сниппет в доке
    for (const dir of ['en', 'ru']) {
      const m = /vimp-engine-core = "(\d+\.\d+)"/.exec(
        read(`docs/${dir}/core.md`),
      );

      expect(m?.[1], `docs/${dir}/core.md`).toBe(expected);
    }
  });
});

describe('docs: правила контракта', () => {
  it('таблица pitfalls.md совпадает с rules/*.js по id и уровню', () => {
    const rulesDir = 'packages/engine/src/devtools/contract/rules';
    const fromCode = {};

    for (const name of fs.readdirSync(path.join(ROOT, rulesDir))) {
      if (name === 'index.js' || !name.endsWith('.js')) {
        continue;
      }

      const src = read(`${rulesDir}/${name}`);
      const id = /id: '([A-Z]\d+)'/.exec(src)?.[1];
      const level = /level: (ERROR|WARN)/.exec(src)?.[1];

      fromCode[id] = level.toLowerCase();
    }

    for (const dir of ['en', 'ru']) {
      const fromDocs = {};

      for (const line of proseLines(read(`docs/${dir}/pitfalls.md`))) {
        const m = /^\|\s*`([A-Z]\d+)`\s*\|\s*(error|warn)\s*\|/.exec(line);

        if (m) {
          fromDocs[m[1]] = m[2];
        }
      }

      expect(fromDocs, `docs/${dir}/pitfalls.md`).toEqual(fromCode);
    }
  });
});
