import { describe, it, expect } from 'vitest';
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import { assertGameConfigShape } from 'vimp-engine/lib/gamePlugin.js';
import hostPlugin from '../../src/host/index.js';
import clientPlugin from '../../src/client/index.js';

// Local safety net over `npm run check:contract`: the engine-side validator
// is the source of truth, but it runs as a separate command — these cases
// fail the ordinary test run, in the same change that broke them.
const clientConfig = hostPlugin.buildClientGameConfig();

describe('game config', () => {
  it('passes the engine gate that runs on plugin load', () => {
    expect(() => assertGameConfigShape(hostPlugin)).not.toThrow();
  });

  // rule B2: the two halves and the manifest must agree with EACH OTHER —
  // a mismatch there is a stale bundle inside one package. Agreement with the
  // installed engine is no longer required of a published game; here it holds
  // because both halves import the value instead of writing a literal
  it('stamps one generation on both halves', () => {
    expect(hostPlugin.engineApi).toBe(clientPlugin.engineApi);
    expect(hostPlugin.engineApi).toBe(ENGINE_API_VERSION);
    expect(hostPlugin.id).toBe(clientPlugin.id);
  });
});

describe('snapshot schema', () => {
  const { snapshot } = hostPlugin.gameConfig;

  it('gives every block a unique id', () => {
    const ids = Object.values(snapshot).map(block => block.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps class 'hot' on indexed blocks only", () => {
    for (const [key, block] of Object.entries(snapshot)) {
      if (block.class === 'hot') {
        expect(['indexed8', 'indexedNoNull8'], key).toContain(block.kind);
      }
    }
  });

  it('interpolates f32 fields of hot blocks only', () => {
    for (const block of Object.values(snapshot)) {
      for (const field of block.fields) {
        if (field.interp !== undefined) {
          expect(block.class).toBe('hot');
          expect(field.ty).toBe('f32');
        }
      }
    }
  });

  it('keys every block after a model, a weapon or a map set', () => {
    const { models, weapons } = hostPlugin.gameConfig.parts;
    const setIds = new Set(
      Object.values(hostPlugin.gameConfig.maps).map(
        map => map.setId ?? hostPlugin.gameConfig.mapSetId,
      ),
    );

    // the core builds a block per model and per weapon under their own names,
    // and the engine one for the dynamic map bodies under the map setId — a
    // block keyed by none of them is one nothing ever fills, and a MISSING one
    // makes the packer reject the frame
    for (const key of Object.keys(snapshot)) {
      expect(key in models || key in weapons || setIds.has(key), key).toBe(true);
    }

    for (const setId of setIds) {
      expect(Object.keys(snapshot), setId).toContain(setId);
    }
  });
});

describe('client config', () => {
  const { gameSets, entitiesOnCanvas, bakedAssets } = clientConfig.parts;

  it('has a gameSets entry for every snapshot key and map setId', () => {
    for (const key of Object.keys(hostPlugin.gameConfig.snapshot)) {
      expect(Object.keys(gameSets)).toContain(key);
    }

    for (const map of Object.values(hostPlugin.gameConfig.maps)) {
      expect(Object.keys(gameSets)).toContain(
        map.setId ?? hostPlugin.gameConfig.mapSetId,
      );
    }
  });

  it('registers every part of a set on a canvas and exports its class', () => {
    for (const names of Object.values(gameSets)) {
      for (const name of names) {
        expect(entitiesOnCanvas[name], name).toBeDefined();
        expect(clientPlugin.parts[name], name).toBeDefined();
      }
    }
  });

  it('bakes only assets that have a baker', () => {
    for (const entries of Object.values(bakedAssets)) {
      for (const entry of entries) {
        expect(clientPlugin.bakers[entry.name], entry.name).toBeDefined();
        expect(entitiesOnCanvas[entry.component], entry.component).toBeDefined();
      }
    }
  });

  it('binds exactly the player keys the host declares', () => {
    const bound = new Set(
      Object.values(clientConfig.modules.controls.keySetList[1]),
    );
    const declared = new Set(Object.keys(hostPlugin.gameConfig.playerKeys));

    expect([...bound].sort()).toEqual([...declared].sort());
  });

  it("maps the engine time key 't' to a time field", () => {
    const { keys, fields } = clientConfig.modules.panel;
    const field = fields.find(item => item.name === keys.t);

    expect(field?.type).toBe('time');
  });

  it('gives every system message code a text', () => {
    const texts = clientConfig.modules.chat.params.messages;

    for (const code of Object.values(hostPlugin.systemMessages)) {
      const [group, index] = code.split(':');

      expect(texts[group]?.[Number(index)], code).toBeDefined();
    }
  });
});
