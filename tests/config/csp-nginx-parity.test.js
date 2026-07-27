import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

import masterConfig from '../../packages/engine/src/config/master.js';

// Регрессия 310fea4: CSP на статике/.wasm в проде ставит Nginx
// (install-system.sh), а мастер лишь документирует ту же строку как
// source of truth (security.csp) — ничто не мешало им разойтись, и именно
// такой дрейф сломал fetch POST /nick через connect-src. Этот тест ловит
// повторный дрейф без развёртывания nginx.
function readNginxCspTemplate() {
  const installScript = readFileSync(
    new URL(
      '../../.github/deployment/install-system.sh',
      import.meta.url,
    ),
    'utf8',
  );

  const match = installScript.match(
    /add_header Content-Security-Policy "([^"]+)" always;/,
  );
  if (!match) {
    throw new Error(
      'Content-Security-Policy header not found in install-system.sh template',
    );
  }
  return match[1];
}

test('CSP в nginx-шаблоне install-system.sh совпадает с security.csp() из master.js', () => {
  const nginxCspTemplate = readNginxCspTemplate();
  const authServiceUrl = 'https://auth.example.com';

  // add-server.sh подставляет authServiceUrl с ведущим пробелом-разделителем
  // (см. add-server.sh: ESC_AUTH_SERVICE_URL = escape_sed(" $AUTH_SERVICE_URL"))
  const nginxCsp = nginxCspTemplate.replace(
    '__AUTH_SERVICE_URL__',
    ` ${authServiceUrl}`,
  );

  expect(nginxCsp).toBe(masterConfig.security.csp(authServiceUrl));
});
