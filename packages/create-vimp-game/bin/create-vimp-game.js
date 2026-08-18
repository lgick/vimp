#!/usr/bin/env node
import { main, reportError } from '../src/cli.js';

// Точка входа `npm create vimp-game <dir>`: разбор argv и печать ошибок
// живут в src/cli.js, здесь остаётся только контракт процесса.

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    reportError(error);
    process.exitCode = 1;
  },
);
