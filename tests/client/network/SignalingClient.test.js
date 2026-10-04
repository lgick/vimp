import { describe, it, expect, beforeEach } from 'vitest';
import SignalingClient from '../../../packages/engine/src/client/network/SignalingClient.js';

// фейковый WebSocket с ручным управлением событиями
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  // симуляция входящего сообщения от мастера
  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  lastSent() {
    return this.sent[this.sent.length - 1];
  }
}

let socket;
let client;

beforeEach(() => {
  socket = null;
  client = new SignalingClient('wss://master/', url => {
    socket = new FakeSocket(url);

    return socket;
  });
});

describe('SignalingClient: подключение и welcome', () => {
  it('connect() открывает сокет с переданным url', () => {
    client.connect();

    expect(socket.url).toBe('wss://master/');
  });

  it('повторный connect() не создаёт второй сокет', () => {
    client.connect();
    const first = socket;

    client.connect();

    expect(socket).toBe(first);
  });

  it('connect() после разрыва открывает новый сокет (reconnect хоста)', () => {
    client.connect();
    const first = socket;

    // разрыв со стороны мастера: onclose обнуляет _ws
    first.close();
    client.connect();

    expect(socket).not.toBe(first);
    expect(client.connected).toBe(true);
  });

  it('welcome кэширует id и iceServers, эмитит событие', () => {
    const events = [];

    client.publisher.on('welcome', msg => events.push(msg));
    client.connect();

    const ice = [{ urls: 'stun:stun.test' }];

    socket.receive({ type: 'welcome', id: 'conn-1', iceServers: ice });

    expect(client.id).toBe('conn-1');
    expect(client.iceServers).toEqual(ice);
    expect(events[0].id).toBe('conn-1');
  });

  it('open/close/socketError ретранслируются через Publisher', () => {
    const seen = [];

    client.publisher.on('open', () => seen.push('open'));
    client.publisher.on('socketError', () => seen.push('error'));
    client.publisher.on('close', () => seen.push('close'));
    client.connect();

    socket.onopen();
    socket.onerror();
    socket.close();

    expect(seen).toEqual(['open', 'error', 'close']);
  });

  it('connected отражает готовность сокета', () => {
    expect(client.connected).toBe(false);

    client.connect();

    expect(client.connected).toBe(true);

    client.close();

    expect(client.connected).toBe(false);
  });
});

describe('SignalingClient: диспетчеризация сообщений', () => {
  beforeEach(() => {
    client.connect();
    socket.receive({ type: 'welcome', id: 'c1', iceServers: [] });
  });

  it('сообщение эмитится подписчикам по type', () => {
    const answers = [];

    client.publisher.on('webrtc_answer', msg => answers.push(msg));

    socket.receive({ type: 'webrtc_answer', hostId: 'h1', sdp: { x: 1 } });

    expect(answers[0].sdp).toEqual({ x: 1 });
  });

  it('невалидный JSON и сообщения без type игнорируются', () => {
    const seen = [];

    client.publisher.on('error', msg => seen.push(msg));

    socket.onmessage({ data: '{ broken' });
    socket.onmessage({ data: JSON.stringify({ noType: true }) });

    expect(seen).toEqual([]);
  });
});

describe('SignalingClient: исходящие сообщения', () => {
  beforeEach(() => {
    client.connect();
  });

  it('sendOffer шлёт webrtc_offer комнате с memberId вкладки', () => {
    client.sendOffer('r1', { type: 'offer' }, 'm1');

    expect(socket.lastSent()).toEqual({
      type: 'webrtc_offer',
      roomId: 'r1',
      sdp: { type: 'offer' },
      memberId: 'm1',
    });
  });

  it('sendOffer переподключения несёт resume', () => {
    client.sendOffer('r1', { type: 'offer' }, 'm1', { resume: true });

    expect(socket.lastSent()).toEqual({
      type: 'webrtc_offer',
      roomId: 'r1',
      sdp: { type: 'offer' },
      memberId: 'm1',
      resume: true,
    });
  });

  it('sendIceCandidate шлёт ice_candidate с targetId', () => {
    client.sendIceCandidate('h1', { candidate: 'c' });

    expect(socket.lastSent()).toEqual({
      type: 'ice_candidate',
      targetId: 'h1',
      candidate: { candidate: 'c' },
    });
  });

  it('pingHost шлёт ping_host комнате', () => {
    client.pingHost('r1', 42);
    expect(socket.lastSent()).toEqual({
      type: 'ping_host',
      roomId: 'r1',
      pingId: 42,
    });
  });

  it('joinRoom шлёт join_room с memberId и токеном', () => {
    client.joinRoom({ roomId: 'r1', memberId: 'm1', token: 't' });

    expect(socket.lastSent()).toEqual({
      type: 'join_room',
      roomId: 'r1',
      memberId: 'm1',
      token: 't',
    });
  });

  it('leaveRoom шлёт leave_room', () => {
    client.leaveRoom('r1');

    expect(socket.lastSent()).toEqual({ type: 'leave_room', roomId: 'r1' });
  });

  it('методы /like·/unlike удалены', () => {
    expect(client.likeHost).toBeUndefined();
    expect(client.unlikeHost).toBeUndefined();
  });

  it('отправка при закрытом сокете молча игнорируется', () => {
    client.close();
    client.sendOffer('h1', {});

    expect(socket.sent).toEqual([]);
  });
});

describe('SignalingClient: исходящие сообщения хоста', () => {
  beforeEach(() => {
    client.connect();
  });

  it('registerHost шлёт register_host без имени комнаты', () => {
    client.registerHost({
      name: 'ignored',
      gameId: 'tanks',
      gameVersion: 'v1',
      maxPlayers: 8,
      info: 'pool_mini',
      memberId: 'm1',
    });

    expect(socket.lastSent()).toEqual({
      type: 'register_host',
      gameId: 'tanks',
      gameVersion: 'v1',
      maxPlayers: 8,
      info: 'pool_mini',
      memberId: 'm1',
    });
  });

  it('registerHost прокидывает identity-токен хостера', () => {
    client.registerHost({ token: 'jwt-token' });

    expect(socket.lastSent()).toEqual({
      type: 'register_host',
      token: 'jwt-token',
    });
  });

  it('reclaimHost шлёт reclaim_host с секретом эпохи и полями комнаты', () => {
    client.reclaimHost({
      roomId: 'r1',
      epoch: 1,
      roomSecret: 's',
      memberId: 'm1',
      token: 't',
      gameId: 'tanks',
      gameVersion: 'v1',
      maxPlayers: 8,
      info: 'arena',
    });

    expect(socket.lastSent()).toEqual({
      type: 'reclaim_host',
      roomId: 'r1',
      epoch: 1,
      roomSecret: 's',
      memberId: 'm1',
      token: 't',
      gameId: 'tanks',
      gameVersion: 'v1',
      maxPlayers: 8,
      info: 'arena',
    });
  });

  it('updateHost шлёт update_host (heartbeat + строка карточки)', () => {
    client.updateHost({ currentPlayers: 3, info: 'pool_mini' });

    expect(socket.lastSent()).toEqual({
      type: 'update_host',
      info: 'pool_mini',
    });
  });

  // null у мастера очищает строку — он обязан доехать, а не потеряться
  it('updateHost с info: null передаёт null', () => {
    client.updateHost({ info: null });

    expect(socket.lastSent()).toEqual({ type: 'update_host', info: null });
  });

  it('sendAnswer шлёт webrtc_answer конкретному клиенту', () => {
    client.sendAnswer('cl1', { type: 'answer' });

    expect(socket.lastSent()).toEqual({
      type: 'webrtc_answer',
      clientId: 'cl1',
      sdp: { type: 'answer' },
    });
  });

  it('pongHost шлёт pong_host на сигнальный ping клиента', () => {
    client.pongHost('cl1', 7);

    expect(socket.lastSent()).toEqual({
      type: 'pong_host',
      clientId: 'cl1',
      pingId: 7,
    });
  });
});

describe('SignalingClient: преемник (host-migration этап 6)', () => {
  const caps = { canHost: true, mobile: false, hidden: false, iceType: null };

  beforeEach(() => {
    client.connect();
  });

  it('joinRoom несёт caps', () => {
    client.joinRoom({ roomId: 'r1', memberId: 'm1', token: 't', caps });

    expect(socket.lastSent()).toEqual({
      type: 'join_room',
      roomId: 'r1',
      memberId: 'm1',
      token: 't',
      caps,
    });
  });

  it('registerHost несёт caps хоста', () => {
    client.registerHost({ gameId: 'g', token: 't', memberId: 'm1', caps });

    expect(socket.lastSent()).toMatchObject({ type: 'register_host', caps });
  });

  it('hostUnreachable шлёт host_unreachable с эпохой (host-migration 7.2)', () => {
    client.hostUnreachable('r1', 3);

    expect(socket.lastSent()).toEqual({
      type: 'host_unreachable',
      roomId: 'r1',
      epoch: 3,
    });
  });

  it('roomPeers шлёт room_peers: подключённые к хосту участники', () => {
    client.roomPeers({ roomId: 'r1', epoch: 2, memberIds: ['m1'] });

    expect(socket.lastSent()).toEqual({
      type: 'room_peers',
      roomId: 'r1',
      epoch: 2,
      memberIds: ['m1'],
    });
  });

  it('probeAck шлёт probe_ack с nonce пробы (host-migration 7.3)', () => {
    client.probeAck('n1');

    expect(socket.lastSent()).toEqual({ type: 'probe_ack', nonce: 'n1' });
  });

  it('registerHost и reclaimHost несут настройки комнаты (host-migration 7.6)', () => {
    const settings = { map: 'dust', friendlyFire: true };

    client.registerHost({ token: 't', settings });
    expect(socket.lastSent()).toMatchObject({
      type: 'register_host',
      settings,
    });

    client.reclaimHost({ roomId: 'r1', epoch: 1, settings });
    expect(socket.lastSent()).toMatchObject({
      type: 'reclaim_host',
      settings,
    });
  });

  it('registerHost преемника несёт roomId, эпоху и promotionToken (7.4)', () => {
    const promotion = {
      roomId: 'r1',
      epoch: 3,
      promotionToken: 'a'.repeat(32),
    };

    client.registerHost({ token: 't', promotion });
    expect(socket.lastSent()).toMatchObject({
      type: 'register_host',
      roomId: 'r1',
      epoch: 3,
      promotionToken: 'a'.repeat(32),
    });

    client.registerHost({ token: 't' });
    expect(socket.lastSent()).not.toHaveProperty('promotionToken');
  });

  it('promoteFailed шлёт promote_failed (7.4)', () => {
    client.promoteFailed({ roomId: 'r1', epoch: 3, promotionToken: 'x' });

    expect(socket.lastSent()).toEqual({
      type: 'promote_failed',
      roomId: 'r1',
      epoch: 3,
      promotionToken: 'x',
    });
  });

  it('handoffBegin шлёт handoff_begin (этап 8)', () => {
    client.handoffBegin({
      roomId: 'r1',
      epoch: 3,
      reason: 'leave',
      stay: false,
    });

    expect(socket.lastSent()).toEqual({
      type: 'handoff_begin',
      roomId: 'r1',
      epoch: 3,
      reason: 'leave',
      stay: false,
    });
  });

  it('hostHealth шлёт host_health (этап 9c)', () => {
    client.hostHealth({
      roomId: 'r1',
      epoch: 3,
      tickRate: 118,
      peerRttMedian: 80,
      peerCount: 2,
    });

    expect(socket.lastSent()).toEqual({
      type: 'host_health',
      roomId: 'r1',
      epoch: 3,
      tickRate: 118,
      peerRttMedian: 80,
      peerCount: 2,
    });
  });

  it('hostLeaving шлёт host_leaving (этап 8)', () => {
    client.hostLeaving('r1', 3);

    expect(socket.lastSent()).toEqual({
      type: 'host_leaving',
      roomId: 'r1',
      epoch: 3,
    });
  });

  it('hostClosing шлёт host_closing (ревью, этап 10)', () => {
    client.hostClosing('r1', 3);

    expect(socket.lastSent()).toEqual({
      type: 'host_closing',
      roomId: 'r1',
      epoch: 3,
    });
  });

  it('memberUpdate шлёт member_update', () => {
    client.memberUpdate('r1', { ...caps, hidden: true });

    expect(socket.lastSent()).toEqual({
      type: 'member_update',
      roomId: 'r1',
      caps: { ...caps, hidden: true },
    });
  });

  it('standbyStatus шлёт standby_status с возрастом точки', () => {
    client.standbyStatus({
      roomId: 'r1',
      epoch: 2,
      checkpointId: 'cp',
      createdAt: 10,
      ageMs: 250,
    });

    expect(socket.lastSent()).toEqual({
      type: 'standby_status',
      roomId: 'r1',
      epoch: 2,
      checkpointId: 'cp',
      createdAt: 10,
      ageMs: 250,
    });
  });
});
