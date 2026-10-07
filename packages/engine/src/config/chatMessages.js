// Английские тексты движковых кодов чата по умолчанию (группы s, v, m, c, n);
// индекс = номер кода. Лежат здесь, а не в clientDefaults: при слиянии
// конфига массивы заменяются целиком, и массив `s` игры стёр бы умолчания.
// Правило перекрытия: строка игры по тому же индексу важнее умолчания;
// '' — игра заглушает сообщение; null/нет индекса — берётся умолчание.
// Новый код движка добавляется в ENGINE_MESSAGE_CODES (host/meta/modules/chat/
// systemMessages.js), сюда и в RESERVED правила B8 одним изменением —
// за этим следит tests/config/chatMessages.test.js.
export default {
  s: [
    'Team {0} is full. Your current team: {1}',
    'Your team: {0}',
    'Your new team: {0}',
    'Your new status: spectator',
    '{0} killed {1}',
    '{0} joined the game',
    '{0} left the game',
    'Host changed',
    'You are no longer the host (connection lost)',
    'Host changed: the previous host was lagging',
    'Host changed: the previous host went inactive',
    'Host changed: the previous host had a poor connection',
  ],
  v: [
    'A vote has been created',
    'Voting has started',
    'Your vote has been accepted',
    'Voting is temporarily unavailable',
    'Vote passed',
    'Vote failed',
    'Usage: /changehost',
    'You are the host — use “Hand over host” in the room menu',
    'No connection to the master server',
    'A host vote was held recently',
    'No other player can host',
    'A host vote is already in progress',
    'A host vote is not possible right now',
    'Vote to change host passed ({0}/{1})',
    'Vote to change host failed ({0}/{1})',
    'Host vote cancelled',
  ],
  m: ['Current map: {0}', 'Next map: {0}'],
  c: ['Command not found', 'Your rank: {0}'],
  n: ['Invalid name', '{0} changed name to {1}'],
};
