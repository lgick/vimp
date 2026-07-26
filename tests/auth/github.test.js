vi.mock('../../packages/auth/src/config/auth.js', () => ({
  default: {
    oauth: {
      github: {
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userApiUrl: 'https://api.github.com/user',
        scope: 'read:user',
      },
    },
  },
}));

const { default: github } = await import('../../packages/auth/src/oauth/github.js');

describe('github oauth provider', () => {
  it('строит authorization url с client_id/state/redirect_uri', () => {
    const url = new URL(github.getAuthorizationUrl('the-state', 'https://auth.local/cb'));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.local/cb');
  });

  it('exchangeCode обменивает code на профиль', async () => {
    const fetchMock = vi.fn(url => {
      if (String(url).includes('access_token')) {
        return { json: async () => ({ 'access_token': 'gho_abc' }) };
      }

      if (String(url).includes('api.github.com/user')) {
        return { json: async () => ({ id: 123, login: 'octocat' }) };
      }

      throw new Error('unexpected fetch: ' + url);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await github.exchangeCode('the-code', 'https://auth.local/cb');

    expect(result.providerUid).toBe('123');
    expect(result.profile.login).toBe('octocat');

    vi.unstubAllGlobals();
  });

  it('exchangeCode бросает ошибку, если токен не получен', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ error: 'bad_verification_code' }) }));

    await expect(github.exchangeCode('bad-code', 'https://auth.local/cb')).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});
