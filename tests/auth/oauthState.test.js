import oauthState from '../../packages/auth/src/lib/oauthState.js';

describe('oauthState', () => {
  it('кодирует и декодирует returnUrl', () => {
    const state = oauthState.encodeState({ returnUrl: 'https://lobby.local/auth' });
    const decoded = oauthState.decodeState(state);

    expect(decoded.returnUrl).toBe('https://lobby.local/auth');
  });

  it('отклоняет подделанный state', () => {
    const state = oauthState.encodeState({ returnUrl: 'https://lobby.local/auth' });
    const tampered = state.replace(/.$/, state.at(-1) === 'a' ? 'b' : 'a');

    expect(() => oauthState.decodeState(tampered)).toThrow();
  });

  it('отклоняет state без сигнатуры', () => {
    expect(() => oauthState.decodeState('not-a-valid-state')).toThrow();
  });
});
