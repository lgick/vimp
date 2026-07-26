import config from '../config/auth.js';

const { clientId, clientSecret, authorizeUrl, tokenUrl, userApiUrl, scope } =
  config.oauth.github;

function getAuthorizationUrl(state, redirectUri) {
  const url = new URL(authorizeUrl);

  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);

  return url.toString();
}

// обменивает code на access_token, затем берёт профиль — providerUid
// это GitHub user id (стабилен даже при смене логина)
async function exchangeCode(code, redirectUri) {
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      'client_id': clientId,
      'client_secret': clientSecret,
      code,
      'redirect_uri': redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    throw new Error(`github token exchange failed: ${tokenData.error || 'unknown'}`);
  }

  const profileRes = await fetch(userApiUrl, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'vimp-auth',
    },
  });

  const profile = await profileRes.json();

  if (!profile.id) {
    throw new Error('github profile fetch failed');
  }

  return { providerUid: String(profile.id), profile };
}

export default { getAuthorizationUrl, exchangeCode };
