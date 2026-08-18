import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildCoreConfig } from 'vimp-engine/lib/coreConfig.js';
import gameConfig from '../../src/config/game.js';
import mapData from '../../src/data/maps/arena.js';

// The `integration` project (node environment): the REAL Rust core, driven
// through the --target nodejs build. That build is not part of `npm test`, so
// without `npm run core:build:node` there is nothing to import and the whole
// file is skipped — a fresh checkout must not fail here, it must tell you the
// core is missing.
const gluePath = fileURLToPath(
  new URL('../../core/pkg-node/{{CRATE_SNAKE}}.js', import.meta.url),
);

const hasCore = existsSync(gluePath);

describe.skipIf(!hasCore)('the Rust core through pkg-node', () => {
  it('boots from the config the engine assembles', async () => {
    const { GameCore } = await import(gluePath);
    const core = new GameCore(JSON.stringify(buildCoreConfig(gameConfig)));

    expect(core).toBeTruthy();
  });

  it('simulates one actor for a second of steps', async () => {
    const { GameCore } = await import(gluePath);
    const core = new GameCore(
      // a fixed seed: two runs of this test must produce the same match
      JSON.stringify(buildCoreConfig(gameConfig, { seed: 1 })),
    );

    core.load_map(JSON.stringify(mapData));

    const [x, y, angle] = mapData.respawns.team1[0];

    core.spawn_actor(1, 'a1', 1, x, y, angle);

    expect(core.is_alive(1)).toBe(true);

    core.apply_input(1, 1, 'down', 'forward');

    // 120 steps of 1/120 s — the engine's own fixed step
    for (let i = 0; i < 120; i += 1) {
      core.step(1 / 120);
    }

    const moved = core.position_of(1);

    // it drove forward: the angle of respawn 0 is +X, and the wall is far
    expect(moved[0]).toBeGreaterThan(x);
    expect(Math.abs(moved[1] - y)).toBeLessThan(1);
  });
});

describe.skipIf(hasCore)('the Rust core', () => {
  it('is not built — run `npm run core:build:node`', () => {
    expect(hasCore).toBe(false);
  });
});
