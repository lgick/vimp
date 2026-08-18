import { createInterface } from 'node:readline/promises';

import { isValidGameId, isValidPackageName } from './tokens.js';

// Интерактив на node:readline/promises — у пакета нулевые рантайм-зависимости:
// он ставится через `npm create`, и каждая зависимость здесь превращается в
// секунду ожидания пользователя.

let rl = null;

function reader() {
  if (rl === null) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  return rl;
}

export function closePrompts() {
  rl?.close();
  rl = null;
}

export async function ask(question, fallback = '') {
  const suffix = fallback === '' ? '' : ` (${fallback})`;
  const answer = await reader().question(`${question}${suffix}: `);

  return answer.trim() === '' ? fallback : answer.trim();
}

// переспрос на месте: без него невалидный id всплывал бы TokenError-ом уже
// после всех пяти вопросов, и вводить пришлось бы заново
export async function askValid(question, fallback, isValid, hint) {
  for (;;) {
    const answer = await ask(question, fallback);

    if (isValid(answer)) {
      return answer;
    }

    process.stdout.write(`  ${hint}\n`);
  }
}

// один проход вопросов; --yes и не-TTY (CI, пайп) отвечают дефолтами.
//
// Дефолты пересчитываются по ходу: человек, назвавший каталог
// `space-arena`, ждёт «Space Arena» и `@vimp-games/space-arena`, а не
// значения, выведенные из аргументов до вопросов
export async function askAnswers(defaults, { interactive = true, derive } = {}) {
  if (!interactive) {
    return { ...defaults };
  }

  try {
    const directory = await ask('Directory', defaults.directory);
    const id = await askValid(
      'Game id',
      derive.id(directory),
      isValidGameId,
      "expected kebab-case, e.g. 'space-arena'",
    );

    return {
      directory,
      id,
      title: await ask('Title', derive.title(id)),
      packageName: await askValid(
        'Package name',
        derive.packageName(id),
        isValidPackageName,
        'expected an npm package name, e.g. @vimp-games/space-arena',
      ),
      author: await ask('Author', defaults.author),
    };
  } finally {
    closePrompts();
  }
}
