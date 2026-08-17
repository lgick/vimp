// коды закрытия транспорта — общий контракт серверных контуров (мастер,
// dedicated, Worker-хост) и клиента, тот же приём, что в gameCodes.js:
// значение не должно расходиться между ними молча. Отказы политики — те, что
// клиент не лечит перезагрузкой, — перечислены в
// `client/network/policyClose.js`, и тест там требует явного решения по
// каждому коду из этой карты
export default {
  staleHost: 4000, // master/SignalingServer.js — сигнальный WS хоста протух
  invalidOrigin: 4001, // master/SignalingServer.js, dedicated/main.js
  blocked: 4002, // master/SignalingServer.js — хостер заблокирован рейтингом
  kickForMaxLatency: 4003, // host/HostGame.js
  kickForMissedPings: 4004, // host/HostGame.js
  kickIdle: 4005, // host/HostGame.js
  roomFull: 4006, // host/PortMachine.js
  // 4007 свободен
  handshakeTimeout: 4008, // dedicated/main.js
  tooManyConnections: 4009, // dedicated/main.js
};
