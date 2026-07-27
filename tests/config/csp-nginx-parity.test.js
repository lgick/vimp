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

// renderNginx зеркалит подстановку add-server.sh (ESC_AUTH_SERVICE_URL =
// escape_sed(" $AUTH_SERVICE_URL"), пусто без ведущего пробела при ответе
// "y"), но не исполняет сам скрипт — не ловит, если ведущий пробел из
// add-server.sh исчезнет; эта связка держится на shellcheck + ручном прогоне.
function renderNginx(template, authServiceUrl) {
  return template.replace(
    '__AUTH_SERVICE_URL__',
    authServiceUrl ? ` ${authServiceUrl}` : '',
  );
}

test('CSP в nginx-шаблоне install-system.sh совпадает с security.csp() из master.js', () => {
  const nginxCspTemplate = readNginxCspTemplate();

  for (const authServiceUrl of ['https://auth.example.com', '']) {
    expect(renderNginx(nginxCspTemplate, authServiceUrl)).toBe(
      masterConfig.security.csp(authServiceUrl),
    );
  }
});
