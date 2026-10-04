// Голосование «Change host» (host-migration этап 10): команда /changehost и
// окно у гостей. Голоса считает мастер, поэтому команда в лобби-режиме не
// уходит хосту. В solo/dedicated мастера нет — команда остаётся обычным
// текстом для игры.

// имя голосования движка; префикс '@' зарезервирован движком
export const CHANGE_HOST_VOTE = '@changeHost';

export const CHANGE_HOST_VALUES = ['Yes', 'No'];

const COMMAND = '/changehost';

/**
 * Разбор сообщения чата.
 * @param {string} text
 * @param {string} bootMode - 'lobby' | 'solo' | 'dedicated'.
 * @returns {'start'|'usage'|null} null — не перехватывать.
 */
export function parseChangeHost(text, bootMode) {
  if (bootMode !== 'lobby' || typeof text !== 'string') {
    return null;
  }

  const [command, ...args] = text.trim().split(/\s+/);

  if (command !== COMMAND) {
    return null;
  }

  return args.length === 0 ? 'start' : 'usage';
}

/**
 * Заголовок окна голосования у гостя.
 * @param {string|null} nick - инициатор.
 * @returns {string}
 */
export function changeHostTitle(nick) {
  return nick ? `Change host? (started by ${nick})` : 'Change host?';
}

/**
 * Ответ окна ('Yes'/'No') — значение host_vote_answer.
 * @param {string} value
 * @returns {'yes'|'no'|null}
 */
export function answerValue(value) {
  const index = CHANGE_HOST_VALUES.indexOf(value);

  return index === -1 ? null : index === 0 ? 'yes' : 'no';
}

// причина отказа мастера → код системного сообщения
const REJECTION_KEYS = {
  host: 'HOST_VOTE_IS_HOST',
  active: 'HOST_VOTE_ACTIVE',
  roomCooldown: 'HOST_VOTE_RECENT',
  userCooldown: 'HOST_VOTE_RECENT',
};

/**
 * Ключ системного сообщения для ошибки мастера на host_vote_start.
 * @param {Object} error - { code, reason }.
 * @returns {string|null} null — ошибка не про голосование.
 */
export function rejectionMessageKey({ code, reason } = {}) {
  if (code === 'noSuccessor') {
    return 'HOST_VOTE_NO_SUCCESSOR';
  }

  if (code === 'voteRejected') {
    return REJECTION_KEYS[reason] ?? 'HOST_VOTE_UNAVAILABLE';
  }

  return null;
}

/**
 * Системное сообщение итога голосования.
 * @param {Object} result - host_vote_result.
 * @returns {{ key: string, params: Array<string> }}
 */
export function resultMessage({ passed, cancelled, yes, eligibleCount }) {
  if (cancelled) {
    return { key: 'HOST_VOTE_CANCELLED', params: [] };
  }

  return {
    key: passed ? 'HOST_VOTE_PASSED' : 'HOST_VOTE_FAILED',
    params: [String(yes), String(eligibleCount)],
  };
}
