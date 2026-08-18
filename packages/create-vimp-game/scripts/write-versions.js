#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { GENERATED_FILE, readRepoVersions } from '../src/versions.js';

// Хук prepack: снимок версий движка и крейта уезжает в пакет, потому что
// вне монорепозитория читать packages/engine/ уже неоткуда. Шаг привязан к
// публикации намеренно — руками его забыли бы.

const versions = await readRepoVersions();

await writeFile(
  GENERATED_FILE,
  `${JSON.stringify(versions, null, 2)}\n`,
  'utf8',
);

process.stdout.write(
  `[create-vimp-game] pins: vimp-engine ${versions.engine}, vimp-engine-core ${versions.core}\n`,
);
