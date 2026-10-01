import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import WebRtcManager, {
  selectedLocalCandidateType,
} from '../../../packages/engine/src/client/network/WebRtcManager.js';

// фейковый DataChannel
class FakeChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.sent = [];
    this.binaryType = 'blob';
  }

  send(data) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  receive(data) {
    this.onmessage?.({ data });
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

// фейковый RTCPeerConnection
class FakePeer {
  constructor(config) {
    this.config = config;
    this.channels = {};
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.connectionState = 'new';
    this.closed = false;
  }

  createDataChannel(label, options) {
    const channel = new FakeChannel(label, options);

    this.channels[label] = channel;

    return channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'fake-offer' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate) {
    this.addedCandidates.push(candidate);
  }

  setConnectionState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  close() {
    this.closed = true;
  }
}

// фейковый сигнальный клиент (только нужный WebRtcManager интерфейс)
const makeSignaling = () => ({
  iceServers: [{ urls: 'stun:stun.test' }],
  publisher: new Publisher(),
  sent: [],
  sendOffer(roomId, sdp, memberId, { resume = false } = {}) {
    this.sent.push({ type: 'offer', roomId, sdp, memberId, resume });
  },
  sendIceCandidate(targetId, candidate) {
    this.sent.push({ type: 'ice', targetId, candidate });
  },
});

let signaling;
let peer;
let manager;

beforeEach(() => {
  signaling = makeSignaling();
  peer = null;
  manager = new WebRtcManager(signaling, {
    peerFactory: config => {
      peer = new FakePeer(config);

      return peer;
    },
  });
});

describe('WebRtcManager: установка соединения', () => {
  it('connect создаёт каналы meta/state с нужными параметрами', async () => {
    await manager.connect('h1');

    expect(peer.channels.meta.options).toEqual({ ordered: true });
    expect(peer.channels.state.options).toEqual({
      ordered: false,
      maxRetransmits: 0,
    });
    expect(peer.channels.meta.binaryType).toBe('arraybuffer');
    expect(peer.channels.state.binaryType).toBe('arraybuffer');
  });

  it('connect использует iceServers сигналинга', async () => {
    await manager.connect('h1');

    expect(peer.config.iceServers).toEqual([{ urls: 'stun:stun.test' }]);
  });

  it('connect отправляет оффер через сигналинг', async () => {
    await manager.connect('h1');

    expect(signaling.sent[0]).toMatchObject({ type: 'offer', roomId: 'h1' });
    expect(peer.localDescription).toEqual({ type: 'offer', sdp: 'fake-offer' });
  });

  it('оффер несёт memberId вкладки', async () => {
    const withMember = new WebRtcManager(signaling, {
      memberId: 'm1',
      peerFactory: config => new FakePeer(config),
    });

    await withMember.connect('r1');

    expect(signaling.sent[0]).toMatchObject({ roomId: 'r1', memberId: 'm1' });
  });

  it('локальные ICE-кандидаты уходят хосту', async () => {
    await manager.connect('h1');

    peer.onicecandidate({ candidate: { candidate: 'a' } });
    peer.onicecandidate({ candidate: null }); // конец сбора — не шлём

    const iceMsgs = signaling.sent.filter(m => m.type === 'ice');

    expect(iceMsgs).toHaveLength(1);
    expect(iceMsgs[0]).toEqual({
      type: 'ice',
      targetId: 'h1',
      candidate: { candidate: 'a' },
    });
  });
});

describe('WebRtcManager: обмен сигналами', () => {
  it('webrtc_answer своей комнаты ставит remoteDescription', async () => {
    await manager.connect('h1');

    signaling.publisher.emit('webrtc_answer', {
      roomId: 'h1',
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    expect(peer.remoteDescription).toEqual({ type: 'answer' });
  });

  // мастер до host-migration этапа 2 адресует ответ полем hostId
  it('hostId в webrtc_answer понимается как roomId', async () => {
    await manager.connect('h1');

    signaling.publisher.emit('webrtc_answer', {
      hostId: 'h1',
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    expect(peer.remoteDescription).toEqual({ type: 'answer' });
  });

  it('ответ от чужого хоста игнорируется', async () => {
    await manager.connect('h1');

    signaling.publisher.emit('webrtc_answer', {
      roomId: 'other',
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    expect(peer.remoteDescription).toBeNull();
  });

  it('удалённый ICE-кандидат от хоста добавляется', async () => {
    await manager.connect('h1');

    signaling.publisher.emit('ice_candidate', {
      fromId: 'h1',
      candidate: { candidate: 'b' },
    });
    await Promise.resolve();

    expect(peer.addedCandidates).toEqual([{ candidate: 'b' }]);
  });
});

describe('WebRtcManager: каналы данных', () => {
  it("'open' эмитится только когда открыты оба канала", async () => {
    const opened = vi.fn();

    manager.publisher.on('open', opened);
    await manager.connect('h1');

    peer.channels.meta.open();
    expect(opened).not.toHaveBeenCalled();

    peer.channels.state.open();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('сообщения из обоих каналов идут одним потоком message', async () => {
    const messages = [];

    manager.publisher.on('message', d => messages.push(d));
    await manager.connect('h1');

    peer.channels.meta.receive('[0,{}]');
    peer.channels.state.receive(new ArrayBuffer(8));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('[0,{}]');
    expect(messages[1]).toBeInstanceOf(ArrayBuffer);
  });

  it('send по умолчанию идёт по надёжному каналу meta', async () => {
    await manager.connect('h1');
    peer.channels.meta.open();

    manager.send('[5,"1:down:fire"]');

    expect(peer.channels.meta.sent).toEqual(['[5,"1:down:fire"]']);
    expect(peer.channels.state.sent).toEqual([]);
  });

  it('send(data, false) уходит по state-каналу', async () => {
    await manager.connect('h1');
    peer.channels.state.open();

    manager.send('pong', false);

    expect(peer.channels.state.sent).toEqual(['pong']);
  });

  it('send в неоткрытый канал молча игнорируется', async () => {
    await manager.connect('h1');

    manager.send('[0,{}]');

    expect(peer.channels.meta.sent).toEqual([]);
  });
});

describe('WebRtcManager: разрывы', () => {
  it('закрытие канала эмитит close один раз', async () => {
    const closed = vi.fn();

    manager.publisher.on('close', closed);
    await manager.connect('h1');

    peer.channels.meta.close();
    peer.channels.state.close();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(peer.closed).toBe(true);
  });

  it('переход connectionState в failed эмитит close', async () => {
    const closed = vi.fn();

    manager.publisher.on('close', closed);
    await manager.connect('h1');

    peer.setConnectionState('failed');

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('close() закрывает peer и эмитит событие', async () => {
    const closed = vi.fn();

    manager.publisher.on('close', closed);
    await manager.connect('h1');

    manager.close();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(peer.closed).toBe(true);
  });
});

describe('WebRtcManager: переподключение (host-migration этап 4)', () => {
  const makeManager = opts =>
    new WebRtcManager(signaling, {
      peerFactory: config => {
        peer = new FakePeer(config);

        return peer;
      },
      ...opts,
    });

  it('оффер переподключения несёт resume', async () => {
    await makeManager({ resume: true }).connect('r1');

    expect(signaling.sent[0]).toMatchObject({ roomId: 'r1', resume: true });
  });

  it('обычный оффер идёт без resume', async () => {
    await manager.connect('r1');

    expect(signaling.sent[0].resume).toBe(false);
  });

  it('destroy отписывается от сигналинга и закрывает pc без close', async () => {
    const closed = vi.fn();

    manager.publisher.on('close', closed);
    await manager.connect('h1');

    manager.destroy();

    signaling.publisher.emit('webrtc_answer', {
      roomId: 'h1',
      sdp: { type: 'answer' },
    });
    await Promise.resolve();
    peer.channels.meta.close();

    expect(peer.closed).toBe(true);
    expect(peer.remoteDescription).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(signaling.publisher.subs.webrtc_answer).toHaveLength(0);
    expect(signaling.publisher.subs.ice_candidate).toHaveLength(0);
    expect(signaling.publisher.subs.error).toHaveLength(0);
  });

  it('брошенный менеджер не ест ответы нового', async () => {
    await manager.connect('r1');
    const oldPeer = peer;

    manager.destroy();

    const next = makeManager({ resume: true });

    await next.connect('r1');
    signaling.publisher.emit('webrtc_answer', {
      roomId: 'r1',
      epoch: 2,
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    expect(oldPeer.remoteDescription).toBeNull();
    expect(peer.remoteDescription).toEqual({ type: 'answer' });
    expect(next.epoch).toBe(2);
  });

  it('ответ эпохи старше minEpoch игнорируется', async () => {
    const next = makeManager({ minEpoch: 3 });

    await next.connect('r1');
    signaling.publisher.emit('webrtc_answer', {
      roomId: 'r1',
      epoch: 2,
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    expect(peer.remoteDescription).toBeNull();
    expect(next.epoch).toBeNull();
  });

  it('после ответа кандидаты другой эпохи отсекаются', async () => {
    await manager.connect('r1');
    signaling.publisher.emit('webrtc_answer', {
      roomId: 'r1',
      epoch: 4,
      sdp: { type: 'answer' },
    });
    await Promise.resolve();

    signaling.publisher.emit('ice_candidate', {
      fromId: 'r1',
      epoch: 3,
      candidate: { candidate: 'old' },
    });
    signaling.publisher.emit('ice_candidate', {
      fromId: 'r1',
      epoch: 4,
      candidate: { candidate: 'own' },
    });
    await Promise.resolve();

    expect(peer.addedCandidates).toEqual([{ candidate: 'own' }]);
  });

  it('каналы не открылись за connectTimeoutMs — close', async () => {
    vi.useFakeTimers();

    try {
      const closed = vi.fn();
      const next = makeManager({ connectTimeoutMs: 10000 });

      next.publisher.on('close', closed);
      await next.connect('r1');

      vi.advanceTimersByTime(9999);
      expect(closed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(peer.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('открытие каналов снимает таймаут установления', async () => {
    vi.useFakeTimers();

    try {
      const closed = vi.fn();
      const next = makeManager({ connectTimeoutMs: 10000 });

      next.publisher.on('close', closed);
      await next.connect('r1');
      peer.channels.meta.open();
      peer.channels.state.open();

      vi.advanceTimersByTime(20000);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('selectedLocalCandidateType (host-migration этап 6)', () => {
  const report = entries => new Map(entries.map(entry => [entry.id, entry]));

  it('выбранная пара по transport.selectedCandidatePairId', () => {
    const stats = report([
      { id: 't', type: 'transport', selectedCandidatePairId: 'p2' },
      {
        id: 'p1',
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        localCandidateId: 'l1',
      },
      { id: 'p2', type: 'candidate-pair', localCandidateId: 'l2' },
      { id: 'l1', type: 'local-candidate', candidateType: 'host' },
      { id: 'l2', type: 'local-candidate', candidateType: 'relay' },
    ]);

    expect(selectedLocalCandidateType(stats)).toBe('relay');
  });

  it('без transport — пара nominated && succeeded', () => {
    const stats = report([
      {
        id: 'p0',
        type: 'candidate-pair',
        nominated: true,
        state: 'in-progress',
        localCandidateId: 'l0',
      },
      {
        id: 'p1',
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        localCandidateId: 'l1',
      },
      { id: 'l0', type: 'local-candidate', candidateType: 'relay' },
      { id: 'l1', type: 'local-candidate', candidateType: 'srflx' },
    ]);

    expect(selectedLocalCandidateType(stats)).toBe('srflx');
  });

  it('выбранной пары нет — null', () => {
    expect(
      selectedLocalCandidateType(report([{ id: 't', type: 'transport' }])),
    ).toBeNull();
    expect(selectedLocalCandidateType(null)).toBeNull();
  });
});

describe('WebRtcManager: iceType и канал standby (этап 6)', () => {
  const stats = candidateType =>
    new Map([
      ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType }],
    ]);

  it('после открытия каналов читает тип кандидата и перечитывает по таймеру', async () => {
    vi.useFakeTimers();

    try {
      const types = [];
      let current = 'srflx';
      const timed = new WebRtcManager(signaling, {
        iceStatsIntervalMs: 1000,
        peerFactory: config => {
          peer = new FakePeer(config);
          peer.getStats = async () => stats(current);

          return peer;
        },
      });

      timed.publisher.on('iceType', type => types.push(type));
      await timed.connect('h1');
      peer.channels.meta.open();
      peer.channels.state.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(timed.iceType).toBe('srflx');

      current = 'relay';
      await vi.advanceTimersByTimeAsync(1000);

      expect(types).toEqual(['srflx', 'relay']);

      timed.close();
      current = 'host';
      await vi.advanceTimersByTimeAsync(5000);

      expect(types).toEqual(['srflx', 'relay']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('канал standby от хоста отдаётся событием', async () => {
    const channels = [];

    manager.publisher.on('standby', channel => channels.push(channel));
    await manager.connect('h1');

    const standby = new FakeChannel('standby');

    peer.ondatachannel({ channel: standby });
    peer.ondatachannel({ channel: new FakeChannel('other') });

    expect(channels).toEqual([standby]);
    expect(standby.binaryType).toBe('arraybuffer');
  });
});

describe('WebRtcManager: плановая передача хоста (host-migration этап 8)', () => {
  const makeManager = opts =>
    new WebRtcManager(signaling, {
      peerFactory: config => {
        peer = new FakePeer(config);

        return peer;
      },
      ...opts,
    });

  it('error migrating — тот же оффер и кандидаты через offerRetryMs', async () => {
    vi.useFakeTimers();

    try {
      const next = makeManager({ offerRetryMs: 1000 });

      await next.connect('r1');
      peer.onicecandidate({ candidate: { candidate: 'c1' } });
      signaling.sent = [];

      signaling.publisher.emit('error', { type: 'error', code: 'migrating' });
      vi.advanceTimersByTime(999);
      expect(signaling.sent).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(signaling.sent).toEqual([
        {
          type: 'offer',
          roomId: 'r1',
          sdp: { type: 'offer', sdp: 'fake-offer' },
          memberId: null,
          resume: false,
        },
        { type: 'ice', targetId: 'r1', candidate: { candidate: 'c1' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('окно connectTimeoutMs отсчитывается от повтора', async () => {
    vi.useFakeTimers();

    try {
      const closed = vi.fn();
      const next = makeManager({ connectTimeoutMs: 5000, offerRetryMs: 1000 });

      next.publisher.on('close', closed);
      await next.connect('r1');
      vi.advanceTimersByTime(4500);
      signaling.publisher.emit('error', { code: 'migrating' });
      vi.advanceTimersByTime(1000 + 4999);
      expect(closed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('другие коды, ответ хоста и закрытие — без повтора', async () => {
    vi.useFakeTimers();

    try {
      const next = makeManager({ offerRetryMs: 1000 });

      await next.connect('r1');
      signaling.sent = [];
      signaling.publisher.emit('error', { code: 'unknownRoom' });
      vi.advanceTimersByTime(1000);
      expect(signaling.sent).toEqual([]);

      signaling.publisher.emit('error', { code: 'migrating' });
      next.close();
      vi.advanceTimersByTime(1000);
      expect(signaling.sent).toEqual([]);

      const answered = makeManager({ offerRetryMs: 1000 });

      await answered.connect('r1');
      signaling.publisher.emit('webrtc_answer', {
        roomId: 'r1',
        epoch: 2,
        sdp: { type: 'answer' },
      });
      await Promise.resolve();
      signaling.sent = [];
      signaling.publisher.emit('error', { code: 'migrating' });
      vi.advanceTimersByTime(1000);
      expect(signaling.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('повторные migrating до повтора — один оффер', async () => {
    vi.useFakeTimers();

    try {
      const next = makeManager({ offerRetryMs: 1000 });

      await next.connect('r1');
      signaling.sent = [];
      signaling.publisher.emit('error', { code: 'migrating' });
      signaling.publisher.emit('error', { code: 'migrating' });
      vi.advanceTimersByTime(1000);

      expect(signaling.sent.filter(m => m.type === 'offer')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
