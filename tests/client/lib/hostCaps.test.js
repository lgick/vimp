import { describe, it, expect } from 'vitest';
import {
  buildHostCaps,
  canHostIn,
  isMobileDevice,
} from '../../../packages/engine/src/client/lib/hostCaps.js';

const coarse = matches => () => ({ matches });

const desktop = (overrides = {}) => ({
  RTCPeerConnection: function RTCPeerConnection() {},
  WebAssembly: {},
  navigator: {},
  matchMedia: coarse(false),
  moduleWorker: () => true,
  ...overrides,
});

describe('isMobileDevice', () => {
  it('Client Hints важнее указателя', () => {
    expect(
      isMobileDevice({
        navigator: { userAgentData: { mobile: false } },
        matchMedia: coarse(true),
      }),
    ).toBe(false);
    expect(
      isMobileDevice({ navigator: { userAgentData: { mobile: true } } }),
    ).toBe(true);
  });

  it('без Client Hints — грубый указатель', () => {
    expect(isMobileDevice({ navigator: {}, matchMedia: coarse(true) })).toBe(
      true,
    );
    expect(isMobileDevice({ navigator: {} })).toBe(false);
  });
});

describe('canHostIn', () => {
  it('десктоп с WebRTC, WebAssembly и модульными Worker-ами', () => {
    expect(canHostIn(desktop())).toBe(true);
  });

  it.each([
    ['без WebRTC', { RTCPeerConnection: undefined }],
    ['без WebAssembly', { WebAssembly: undefined }],
    ['без модульных Worker-ов', { moduleWorker: () => false }],
    ['мобильный', { matchMedia: coarse(true) }],
  ])('%s — нет', (_name, overrides) => {
    expect(canHostIn(desktop(overrides))).toBe(false);
  });
});

describe('buildHostCaps', () => {
  it('собирает caps: видимость вкладки и тип ICE-кандидата', () => {
    expect(
      buildHostCaps(
        { canHost: true, iceType: 'relay' },
        { ...desktop(), document: { hidden: true } },
      ),
    ).toEqual({
      canHost: true,
      mobile: false,
      hidden: true,
      iceType: 'relay',
      fps: null,
    });
  });

  it('FPS рендера округляется; не число — null (этап 9c)', () => {
    const env = { ...desktop(), document: {} };

    expect(buildHostCaps({ canHost: true, fps: 59.6 }, env).fps).toBe(60);
    expect(buildHostCaps({ canHost: true, fps: NaN }, env).fps).toBeNull();
  });

  it('iceType ещё не известен — null', () => {
    expect(
      buildHostCaps({ canHost: false }, { ...desktop(), document: {} }),
    ).toEqual({
      canHost: false,
      mobile: false,
      hidden: false,
      iceType: null,
      fps: null,
    });
  });
});
