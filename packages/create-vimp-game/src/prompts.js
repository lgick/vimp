import { createInterface } from 'node:readline/promises';

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

// один проход вопросов; --yes и не-TTY (CI, пайп) отвечают дефолтами
export async function askAnswers(defaults, { interactive = true } = {}) {
  if (!interactive) {
    return { ...defaults };
  }

  try {
    return {
      directory: await ask('Directory', defaults.directory),
      id: await ask('Game id', defaults.id),
      title: await ask('Title', defaults.title),
      packageName: await ask('Package name', defaults.packageName),
      author: await ask('Author', defaults.author),
    };
  } finally {
    closePrompts();
  }
}
