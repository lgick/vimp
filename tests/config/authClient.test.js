import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';

// Регрессия a3ed5cb: authClient.js импортируется и серверным
// master/main.js под чистым Node, где import.meta.env не определён.
// Vitest сам подставляет import.meta.env, поэтому этот путь не ловится
// обычным запуском тестов — здесь мы шеллим настоящий node.
test('authClient.js импортируется под чистым Node (без import.meta.env)', () => {
  const url = new URL(
    '../../packages/engine/src/config/authClient.js',
    import.meta.url,
  ).href;

  let error;
  try {
    // process.execPath — тот же бинарник Node, что и Vitest, без опоры на PATH
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { stdio: 'pipe' },
    );
  } catch (e) {
    error = e;
  }

  // при падении показываем stderr дочернего процесса (сам TypeError)
  expect(error, error && String(error.stderr)).toBeUndefined();
});
