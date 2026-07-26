import github from './github.js';

// реестр провайдеров: B1 — только github (решение пользователя — начать с
// одного); google/apple добавляются той же формой
// { getAuthorizationUrl(state, redirectUri), exchangeCode(code, redirectUri) }
const providers = { github };

export function getProvider(name) {
  const provider = providers[name];

  if (!provider) {
    throw new Error(`unknown oauth provider: ${name}`);
  }

  return provider;
}

export default { getProvider };
