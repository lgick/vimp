import fs from 'node:fs';

// версию штампует бокс, а не клиент (решение 5 плана): клиент движка
// раздаёт этот же бокс из своего образа
export const ENGINE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
