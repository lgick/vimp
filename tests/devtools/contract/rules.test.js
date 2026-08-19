import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadContext } from '../../../packages/engine/src/devtools/contract/loadContext.js';
import { rules } from '../../../packages/engine/src/devtools/contract/rules/index.js';
import {
  FAIL,
  PASS,
  SKIP,
} from '../../../packages/engine/src/devtools/contract/result.js';
import { ENGINE_API_VERSION } from '../../../packages/engine/src/config/opcodes.js';

// По негативной фикстуре на правило. Правило, которое не умеет краснеть,
// бесполезно ровно так же, как отсутствующее: тесты здесь проверяют не
// текст сообщения, а сам факт поимки.
//
// Группа A работает с файлами — её фикстуры собираются во временной папке
// (два пакета: правильный и сломанный по всем пунктам сразу). Группы B/C/D/E
// работают с объектами — их фикстуры получаются точечной подменой полей в
// контексте miniGame, который заведомо зелёный (см. miniGame.test.js).

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../../packages/engine/tests/fixtures/miniGame',
);

const SCRIPTS = [
  'build',
  'build:client',
  'build:host',
  'build:assets',
  'build:manifest',
  'core:build:web',
  'core:build:node',
  'core:test',
  'test',
];

const VITE_OK = `import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      external: [/^pixi\\.js(\\/.*)?$/],
      output: {
        inlineDynamicImports: true,
        entryFileNames: \`\${mode}-[hash].js\`,
      },
    },
  },
}));
`;

const rule = id => rules.find(item => item.id === id);
const check = (id, ctx) => rule(id).check(ctx);
const violations = (id, ctx) => check(id, ctx).violations.join('\n');

let base;
let root;
let goodCtx;
let badCtx;

beforeAll(async () => {
  base = await loadContext(FIXTURE);
  root = await mkdtemp(path.join(tmpdir(), 'vimp-contract-'));

  await writeGood(path.join(root, 'good'));
  await writeBad(path.join(root, 'bad'));

  goodCtx = await loadContext(path.join(root, 'good'));
  badCtx = await loadContext(path.join(root, 'bad'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// ***** A. пакет и сборка ***** //

describe('A. package and build', () => {
  it('passes on a well-formed package', () => {
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      expect(`${id}: ${violations(id, goodCtx)}`).toBe(`${id}: `);
    }
  });

  it('A1 catches the package.json fields', () => {
    const found = violations('A1', badCtx);

    expect(found).toMatch(/"type" is "commonjs"/);
    expect(found).toMatch(/"files" must list "dist"/);
    expect(found).toMatch(/pixi\.js is in dependencies/);
    expect(found).toMatch(/vimp-engine is in dependencies/);
    expect(found).toMatch(/publishConfig\.access/);
  });

  it('A2 catches missing scripts', () => {
    expect(violations('A2', badCtx)).toMatch(/script "core:build:node"/);
  });

  it('A3 catches entries outside src/host and src/client', () => {
    expect(violations('A3', badCtx)).toMatch(/src\/host\/index\.js is missing/);
  });

  it('A4 catches the rollup options and build.lib', () => {
    const found = violations('A4', badCtx);

    expect(found).toMatch(/preserveEntrySignatures/);
    expect(found).toMatch(/build\.lib is used/);
  });

  it('A5 catches crate-type, rapier2d and a stale engine pin', () => {
    const found = violations('A5', badCtx);

    expect(found).toMatch(/crate-type does not list "rlib"/);
    expect(found).toMatch(/enhanced-determinism/);
    expect(found).toMatch(/older than this engine's crate/);
  });

  // регрессия: раньше отсутствие любого входа пина давало pass — то есть
  // флагманское правило рапортовало «всё хорошо» ровно там, где проверить
  // ничего не смогло
  it('A5 reports an unchecked pin instead of passing it', () => {
    const notes = [];
    const result = check('A5', {
      ...goodCtx,
      engineCoreVersion: null,
      notes,
    });

    expect(result.status).toBe(PASS);
    expect(notes.join('\n')).toMatch(/pin was NOT checked/);
  });

  // [patch.crates-io] объявляет vimp-engine-core путём, без версии: поиск
  // по всему файлу находил бы его первым и молча пропускал пин
  it('A5 reads the pin from [dependencies], not from [patch.crates-io]', () => {
    const notes = [];
    const cargoText = [
      '[lib]',
      'crate-type = ["cdylib", "rlib"]',
      '',
      '[patch.crates-io]',
      'vimp-engine-core = { path = "/tmp/core" }',
      '',
      '[dependencies]',
      'rapier2d = { version = "0.2", features = ["enhanced-determinism"] }',
      'vimp-engine-core = "0.1"',
    ].join('\n');

    const found = check('A5', {
      ...goodCtx,
      cargoText,
      workspaceCargoText: null,
      engineCoreVersion: '9.9.9',
      notes,
    }).violations.join('\n');

    expect(found).toMatch(/pinned to 0\.1, older than this engine's crate/);
  });

  it('A6 catches a mismatched id, a missing entry and an uncovered field', () => {
    const found = violations('A6', badCtx);

    expect(found).toMatch(/differs from the host plugin id/);
    expect(found).toMatch(/entries\.wasmNode points outside dist\//);
    expect(found).toMatch(/roomForm field "roundTime" has no roomDefaults/);
  });

  it('skips every A rule when the package files are absent', () => {
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      expect(check(id, base).status).toBe(SKIP);
    }
  });
});

// ***** B. host ***** //

describe('B. host', () => {
  it('B1 catches a missing field and a non-array chatCommands', () => {
    const found = violations('B1', {
      ...base,
      hostPlugin: { ...base.hostPlugin, createModules: undefined, chatCommands: {} },
    });

    expect(found).toMatch(/HostPlugin\.createModules is missing/);
    expect(found).toMatch(/chatCommands must be an array/);
  });

  it('B2 catches a wrong engineApi and a hardcoded one', () => {
    const found = violations('B2', {
      ...base,
      hostPlugin: { ...base.hostPlugin, engineApi: 999 },
      hostText: 'export default { engineApi: 3 };',
    });

    expect(found).toMatch(/host plugin declares engineApi v999/);
    expect(found).toMatch(/hardcodes engineApi/);
  });

  it('B3 catches a gameConfig missing a required path', () => {
    const { playerKeys, ...gameConfig } = base.gameConfig;

    expect(
      violations('B3', {
        ...base,
        hostPlugin: { ...base.hostPlugin, gameConfig },
      }),
    ).toMatch(/playerKeys/);
  });

  it('B4 catches a game with no playing team', () => {
    expect(
      violations('B4', {
        ...base,
        gameConfig: { ...base.gameConfig, teams: { spectators: 1 } },
      }),
    ).toMatch(/no playing team/);
  });

  it('B5 catches a field the host drops and an unknown control', () => {
    const found = violations('B5', {
      ...base,
      gameConfig: {
        ...base.gameConfig,
        roomForm: [{ name: 'gravity', control: 'range' }],
      },
    });

    expect(found).toMatch(/"gravity" is not read by the host/);
    expect(found).toMatch(/control "range" does not exist/);
  });

  it("B6 catches the reserved panel key 't'", () => {
    expect(
      violations('B6', {
        ...base,
        gameConfig: {
          ...base.gameConfig,
          panel: { fields: { timer: { key: 't', value: 0 } } },
        },
      }),
    ).toMatch(/reserved by the engine/);
  });

  it('B7 catches a command shadowing an engine one', () => {
    expect(
      violations('B7', {
        ...base,
        hostPlugin: { ...base.hostPlugin, chatCommands: [{ name: '/rank' }] },
      }),
    ).toMatch(/"\/rank" is an engine command/);
  });

  it('B8 catches a code inside an engine range', () => {
    expect(
      violations('B8', {
        ...base,
        hostPlugin: { ...base.hostPlugin, systemMessages: { KILL: 's:4' } },
      }),
    ).toMatch(/overwrites the engine message s:4/);
  });

  it('B9 catches a reserved vote name and a template-less menu entry', () => {
    const vote = base.clientConfig.modules.vote.params;
    const found = violations('B9', {
      ...base,
      clientConfig: withVote(base, {
        templates: { ...vote.templates, mapChange: ['Choose'] },
        menu: [...vote.menu, ['surrender', ['Surrender']]],
      }),
    });

    expect(found).toMatch(/"mapChange" reuses a reserved vote name/);
    expect(found).toMatch(/"surrender" has no template/);
  });

  it('B10 catches respawns below maxPlayers and a team without them', () => {
    const found = violations('B10', {
      ...base,
      gameConfig: {
        ...base.gameConfig,
        roomDefaults: { maxPlayers: 16 },
        teams: { ...base.gameConfig.teams, team2: 3 },
      },
    });

    expect(found).toMatch(/team "team2" has no respawns/);
    expect(found).toMatch(/respawn point\(s\) for 16 players/);
  });
});

// ***** C. client ***** //

describe('C. client', () => {
  it('C1 catches a missing hook', () => {
    expect(
      violations('C1', {
        ...base,
        clientPlugin: {
          ...base.clientPlugin,
          hooks: { ...base.clientPlugin.hooks, onPanel: undefined },
        },
      }),
    ).toMatch(/hooks\.onPanel is missing/);
  });

  it('C2 catches a part missing from entitiesOnCanvas and from parts', () => {
    const found = violations('C2', {
      ...base,
      clientConfig: withParts(base, {
        gameSets: { ...base.clientConfig.parts.gameSets, a1: ['Ghost'] },
      }),
    });

    expect(found).toMatch(/missing from entitiesOnCanvas/);
    expect(found).toMatch(/not exported in ClientPlugin\.parts/);
  });

  it('C3 catches a snapshot key and a map setId without a gameSets entry', () => {
    const found = violations('C3', {
      ...base,
      clientConfig: withParts(base, { gameSets: { a1: ['Actor'] } }),
    });

    expect(found).toMatch(/snapshot key "e1"/);
    expect(found).toMatch(/setId "m1"/);
  });

  it('C4 catches an unknown service', () => {
    expect(
      violations('C4', {
        ...base,
        clientConfig: withParts(base, {
          componentDependencies: { physics: ['Actor'] },
        }),
      }),
    ).toMatch(/service "physics"/);
  });

  it('C4 accepts localPlayer — the fourth service of the pool', () => {
    expect(
      violations('C4', {
        ...base,
        clientConfig: withParts(base, {
          componentDependencies: { localPlayer: ['Actor'] },
        }),
      }),
    ).toBe('');
  });

  it("C5 catches a missing 't' field and a wrong type", () => {
    const panel = base.clientConfig.modules.panel;

    expect(
      violations('C5', {
        ...base,
        clientConfig: withModules(base, { panel: { ...panel, keys: { h: 'energy' } } }),
      }),
    ).toMatch(/panel\.keys has no 't'/);

    expect(
      violations('C5', {
        ...base,
        clientConfig: withModules(base, {
          panel: {
            ...panel,
            fields: [{ name: 'time', elem: 'panel-time', type: 'bar' }],
          },
        }),
      }),
    ).toMatch(/expected 'time'/);
  });

  it('C6 warns on a stat with a different column count', () => {
    const stat = base.clientConfig.modules.stat;
    const result = check('C6', {
      ...base,
      clientConfig: withModules(base, {
        stat: { params: { ...stat.params, columns: ['names', 'score'] } },
      }),
    });

    expect(result.status).toBe(FAIL);
    expect(rule('C6').level).toBe('warn');
  });

  it('C7 catches spectator keys, engine codes and playerKeys drift', () => {
    const found = violations('C7', {
      ...base,
      clientConfig: withModules(base, {
        controls: { keySetList: [{}, { 67: 'forward', 83: 'back' }] },
      }),
    });

    expect(found).toMatch(/no "nextPlayer"/);
    expect(found).toMatch(/binds code 67/);
    expect(found).toMatch(/playerKeys\."fire" has no key/);
  });

  it('C8 catches a baker that does not exist', () => {
    expect(
      violations('C8', {
        ...base,
        clientConfig: withParts(base, {
          bakedAssets: { vimp: [{ name: 'smoke', component: 'Actor' }] },
        }),
      }),
    ).toMatch(/baker "smoke" is not in ClientPlugin\.bakers/);
  });

  it('C9 catches a code without a client text', () => {
    expect(
      violations('C9', {
        ...base,
        hostPlugin: { ...base.hostPlugin, systemMessages: { LATE: 'g:7' } },
      }),
    ).toMatch(/no text in chat\.params\.messages\.g\[7\]/);
  });

  it('C10 catches formId, a nickname field and a renamed model field', () => {
    const found = violations('C10', {
      ...base,
      authSchema: {
        elems: { formId: 'auth-form' },
        params: [{ name: 'nickname' }, { name: 'character' }],
      },
    });

    expect(found).toMatch(/formId does not exist/);
    expect(found).toMatch(/fieldsId is missing/);
    expect(found).toMatch(/"nickname" looks like a nickname field/);
    expect(found).toMatch(/no param named exactly "model"/);
  });
});

// ***** D. снапшот ***** //

describe('D. snapshot', () => {
  it('D1 catches a duplicate block id', () => {
    expect(
      violations('D1', {
        ...base,
        gameConfig: withSnapshot(base, {
          e1: { ...base.gameConfig.snapshot.e1, id: 1 },
        }),
      }),
    ).toMatch(/id 1 is used by both/);
  });

  it('D2 catches a hot block of the wrong kind and an unclassified event', () => {
    const found = violations('D2', {
      ...base,
      gameConfig: withSnapshot(base, {
        e1: { ...base.gameConfig.snapshot.e1, class: 'hot' },
      }),
    });

    expect(found).toMatch(/cannot be class 'hot'/);
    expect(found).toMatch(/must be class 'event'/);
  });

  it('D3 catches interp outside a hot f32 field', () => {
    const found = violations('D3', {
      ...base,
      gameConfig: withSnapshot(base, {
        a1: {
          ...base.gameConfig.snapshot.a1,
          fields: [{ name: 'team', ty: 'u8', interp: 'lerp' }],
        },
        e1: {
          ...base.gameConfig.snapshot.e1,
          fields: [{ name: 'x', ty: 'f32', interp: 'lerp' }],
        },
      }),
    });

    expect(found).toMatch(/interp on ty "u8"/);
    expect(found).toMatch(/interp on a class "event" block/);
  });
});

// ***** E. ассеты ***** //

describe('E. assets', () => {
  const built = extra => ({
    ...base,
    distFiles: new Set(['manifest.json', ...(extra ?? [])]),
    clientConfig: withParts(base, {
      sounds: {
        codecList: ['webm', 'mp3'],
        sounds: { shot: { file: 'shot' } },
      },
    }),
  });

  it('E1 catches a sound shipped without its mp3', () => {
    expect(violations('E1', built(['sounds/shot.webm']))).toMatch(
      /dist\/sounds\/shot\.mp3 is missing/,
    );
  });

  it('E2 catches a map image that is not in dist/img', () => {
    expect(violations('E2', built())).toMatch(
      /dist\/img\/fixture-tiles\.png is missing/,
    );
  });

  it('E3 warns on an empty sound registry, and only once built', () => {
    expect(check('E3', base).status).toBe(SKIP);

    const result = check('E3', { ...base, distFiles: new Set() });

    expect(result.status).toBe(FAIL);
    expect(rule('E3').level).toBe('warn');
  });

  it('E1 passes when both codecs are present', () => {
    expect(
      check('E1', built(['sounds/shot.webm', 'sounds/shot.mp3'])).status,
    ).toBe(PASS);
  });
});

// ***** вспомогательное ***** //

function withParts(ctx, patch) {
  return {
    ...ctx.clientConfig,
    parts: { ...ctx.clientConfig.parts, ...patch },
  };
}

function withModules(ctx, patch) {
  return {
    ...ctx.clientConfig,
    modules: { ...ctx.clientConfig.modules, ...patch },
  };
}

function withVote(ctx, params) {
  return withModules(ctx, { vote: { params } });
}

function withSnapshot(ctx, patch) {
  return {
    ...ctx.gameConfig,
    snapshot: { ...ctx.gameConfig.snapshot, ...patch },
  };
}

async function writeGood(dir) {
  await mkdir(path.join(dir, 'src', 'host'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'client'), { recursive: true });
  await mkdir(path.join(dir, 'core'), { recursive: true });
  await mkdir(path.join(dir, 'dist', 'core-node'), { recursive: true });
  await mkdir(path.join(dir, 'dist', 'assets'), { recursive: true });

  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@vimp-games/demo',
      type: 'module',
      files: ['dist'],
      publishConfig: { access: 'public' },
      scripts: Object.fromEntries(SCRIPTS.map(name => [name, 'true'])),
      peerDependencies: { 'pixi.js': '^8.0.0' },
      devDependencies: { 'pixi.js': '^8.0.0', 'vimp-engine': '^0.9.0' },
    }),
  );

  await writeFile(path.join(dir, 'vite.config.js'), VITE_OK);
  await writeFile(
    path.join(dir, 'core', 'Cargo.toml'),
    '[package]\nname = "demo-core"\n\n[lib]\ncrate-type = ["cdylib", "rlib"]\n\n' +
      '[dependencies]\nrapier2d = { workspace = true }\n' +
      `vimp-engine-core = "${base.engineCoreVersion ?? '0.0.0'}"\n`,
  );
  await writeFile(
    path.join(dir, 'Cargo.toml'),
    '[workspace.dependencies]\n' +
      'rapier2d = { version = "0.34.0", features = ["enhanced-determinism"] }\n',
  );

  const plugin = half =>
    `import { ENGINE_API_VERSION } from 'vimp-engine';\n` +
    `export default { id: 'demo', engineApi: ${ENGINE_API_VERSION}, half: '${half}' };\n`;

  // исходники не импортируются (vimp-engine из временной папки не
  // резолвится) — они нужны правилу A3 как файлы и B2 как текст
  await writeFile(path.join(dir, 'src', 'host', 'index.js'), plugin('host'));
  await writeFile(path.join(dir, 'src', 'client', 'index.js'), plugin('client'));

  const built = half =>
    `export default { id: 'demo', engineApi: ${ENGINE_API_VERSION}, half: '${half}' };\n`;

  await writeFile(path.join(dir, 'dist', 'host-abc.js'), built('host'));
  await writeFile(path.join(dir, 'dist', 'client-abc.js'), built('client'));
  await writeFile(path.join(dir, 'dist', 'core-node', 'demo.js'), 'export {};\n');
  await writeFile(path.join(dir, 'dist', 'assets', 'demo_bg.wasm'), '');

  await writeFile(
    path.join(dir, 'dist', 'manifest.json'),
    JSON.stringify({
      id: 'demo',
      engineApi: ENGINE_API_VERSION,
      assetsBase: '/games/demo/',
      entries: {
        host: '/games/demo/host-abc.js',
        client: '/games/demo/client-abc.js',
        wasm: '/games/demo/assets/demo_bg.wasm',
        wasmNode: './core-node/demo.js',
      },
      roomDefaults: { maxPlayers: 8 },
      roomForm: [
        { name: 'maxPlayers', control: 'text' },
        { name: 'map', control: 'select', source: 'maps' },
      ],
    }),
  );
}

async function writeBad(dir) {
  await mkdir(path.join(dir, 'core'), { recursive: true });
  await mkdir(path.join(dir, 'dist'), { recursive: true });

  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@vimp-games/broken',
      type: 'commonjs',
      files: ['src'],
      scripts: { build: 'true' },
      dependencies: { 'pixi.js': '^8.0.0', 'vimp-engine': '^0.9.0' },
    }),
  );

  await writeFile(
    path.join(dir, 'vite.config.js'),
    "export default { build: { lib: { entry: 'src/index.js' } } };\n",
  );

  await writeFile(
    path.join(dir, 'core', 'Cargo.toml'),
    '[package]\nname = "broken-core"\n\n[lib]\ncrate-type = ["cdylib"]\n\n' +
      '[dependencies]\nrapier2d = "0.34.0"\nvimp-engine-core = "0.1.0"\n',
  );

  await writeFile(
    path.join(dir, 'dist', 'host-abc.js'),
    `export default { id: 'other', engineApi: ${ENGINE_API_VERSION} };\n`,
  );

  await writeFile(
    path.join(dir, 'dist', 'manifest.json'),
    JSON.stringify({
      id: 'broken',
      engineApi: ENGINE_API_VERSION,
      assetsBase: '/games/broken/',
      entries: {
        host: '/games/broken/host-abc.js',
        client: '/games/broken/client-missing.js',
        wasmNode: '../core/pkg-node/broken.js',
      },
      roomDefaults: { maxPlayers: 8 },
      roomForm: [
        { name: 'maxPlayers', control: 'text' },
        { name: 'roundTime', control: 'text' },
      ],
    }),
  );
}
