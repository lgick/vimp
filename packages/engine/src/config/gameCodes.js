// коды игровых информ-сообщений (порт GAME_INFORM_DATA, см.
// docs/en/network.md) — общий контракт хоста (SocketManager) и клиента
// (main.js): значение не должно расходиться между ними молча
export default {
  winnerTeam: [0],
  roundStart: [1],
  gameOver: [2],
};
