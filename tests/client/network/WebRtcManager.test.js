import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import WebRtcManager from '../../../packages/engine/src/client/network/WebRtcManager.js';

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
  sendOffer(hostId, sdp) {
    this.sent.push({ type: 'offer', hostId, sdp });
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

    expect(signaling.sent[0]).toMatchObject({ type: 'offer', hostId: 'h1' });
    expect(peer.localDescription).toEqual({ type: 'offer', sdp: 'fake-offer' });
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
  it('webrtc_answer от своего хоста ставит remoteDescription', async () => {
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
      hostId: 'other',
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
