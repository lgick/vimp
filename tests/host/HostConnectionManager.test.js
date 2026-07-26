import { describe, it, expect, vi, beforeEach } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';
import HostConnectionManager from '../../packages/engine/src/client/network/HostConnectionManager.js';

// Юнит-тесты WebRTC-answerer хоста: приём оффера/answer, каналы meta/state
// (ondatachannel), классификация reliable → meta/state, бэкпрешер на state,
// ICE, сигнальный pong, закрытие. RTCPeerConnection/DataChannel — фейки.

const makeChannel = label => ({
  label,
  binaryType: '',
  readyState: 'open',
  bufferedAmount: 0,
  send: vi.fn(),
  onopen: null,
  onmessage: null,
  onclose: null,
});

const makePc = () => ({
  connectionState: 'new',
  ondatachannel: null,
  onicecandidate: null,
  onconnectionstatechange: null,
  localDescription: { type: 'answer', sdp: 'a=answer' },
  setRemoteDescription: vi.fn().mockResolvedValue(undefined),
  createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'a=answer' }),
  setLocalDescription: vi.fn().mockResolvedValue(undefined),
  addIceCandidate: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
});

const makeSignaling = () => ({
  iceServers: [],
  publisher: new Publisher(),
  sendIceCandidate: vi.fn(),
  sendAnswer: vi.fn(),
  pongHost: vi.fn(),
});

describe('HostConnectionManager', () => {
  let signaling;
  let controller;
  let pc;
  let mgr;

  beforeEach(() => {
    signaling = makeSignaling();
    controller = { open: vi.fn(), send: vi.fn(), disconnect: vi.fn() };
    pc = makePc();
    mgr = new HostConnectionManager(signaling, controller, {
      peerFactory: () => pc,
      backpressureThreshold: 1000,
    });
  });

  // подключает пира c1 и открывает оба канала; возвращает {meta, state}
  const connectPeer = async (clientId = 'c1') => {
    await mgr.onOffer({ clientId, sdp: { type: 'offer' } });

    const meta = makeChannel('meta');
    const state = makeChannel('state');

    pc.ondatachannel({ channel: meta });
    pc.ondatachannel({ channel: state });
    meta.onopen();
    state.onopen();

    return { meta, state };
  };

  it('на оффер создаёт answer и шлёт его клиенту', async () => {
    await mgr.onOffer({ clientId: 'c1', sdp: { type: 'offer' } });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer' });
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(signaling.sendAnswer).toHaveBeenCalledWith('c1', pc.localDescription);
  });

  it('подписан на webrtc_offer сигналинга', () => {
    // побочный эффект onOffer до первого await — доказательство подписки
    signaling.publisher.emit('webrtc_offer', {
      clientId: 'sub',
      sdp: { type: 'offer' },
    });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer' });
  });

  it('оба канала открыты → поднимает соединение клиента в Worker', async () => {
    await connectPeer('c1');

    expect(controller.open).toHaveBeenCalledWith('c1', expect.any(Object));
  });

  it('входящее сообщение канала уходит в Worker', async () => {
    const { meta } = await connectPeer('c1');

    meta.onmessage({ data: '[5,"1:down:fire"]' });

    expect(controller.send).toHaveBeenCalledWith('c1', '[5,"1:down:fire"]');
  });

  it('reliable → meta, не-reliable → state', async () => {
    const { meta, state } = await connectPeer('c1');
    const delivery = controller.open.mock.calls[0][1];

    delivery.onMessage('json', true);
    delivery.onMessage(new ArrayBuffer(8), false);

    expect(meta.send).toHaveBeenCalledWith('json');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('бэкпрешер: позиционный кадр дропается при переполнении state', async () => {
    const { state } = await connectPeer('c1');
    const delivery = controller.open.mock.calls[0][1];

    state.bufferedAmount = 5000; // > threshold 1000
    delivery.onMessage(new ArrayBuffer(8), false);

    expect(state.send).not.toHaveBeenCalled();
  });

  it('meta не дропается даже при большом bufferedAmount', async () => {
    const { meta } = await connectPeer('c1');
    const delivery = controller.open.mock.calls[0][1];

    meta.bufferedAmount = 5000;
    delivery.onMessage('critical', true);

    expect(meta.send).toHaveBeenCalledWith('critical');
  });

  it('ICE-кандидат клиента добавляется в peer', async () => {
    await connectPeer('c1');

    await mgr.onRemoteCandidate({ fromId: 'c1', candidate: { c: 1 } });

    expect(pc.addIceCandidate).toHaveBeenCalledWith({ c: 1 });
  });

  it('сигнальный ping клиента → pong', () => {
    mgr.onPing({ clientId: 'c9', pingId: 42 });

    expect(signaling.pongHost).toHaveBeenCalledWith('c9', 42);
  });

  it('разрыв соединения закрывает peer и уведомляет Worker', async () => {
    await connectPeer('c1');

    pc.connectionState = 'failed';
    pc.onconnectionstatechange();

    expect(controller.disconnect).toHaveBeenCalledWith('c1');
    expect(pc.close).toHaveBeenCalled();
    expect(mgr.peerCount).toBe(0);
  });

  it('onPeersChange сообщает число пиров на подключении/отключении', async () => {
    const onPeersChange = vi.fn();

    mgr = new HostConnectionManager(signaling, controller, {
      peerFactory: () => pc,
      onPeersChange,
    });

    await connectPeer('c1');
    expect(onPeersChange).toHaveBeenLastCalledWith(1);

    pc.connectionState = 'closed';
    pc.onconnectionstatechange();
    expect(onPeersChange).toHaveBeenLastCalledWith(0);
  });

  it("транзиентный 'disconnected' не рвёт соединение", async () => {
    await connectPeer('c1');

    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange();

    expect(controller.disconnect).not.toHaveBeenCalled();
    expect(mgr.peerCount).toBe(1);
  });

  it('гонка: закрытие канала до открытия второго не поднимает фантома', async () => {
    await mgr.onOffer({ clientId: 'c1', sdp: { type: 'offer' } });

    const meta = makeChannel('meta');
    const state = makeChannel('state');

    pc.ondatachannel({ channel: meta });
    pc.ondatachannel({ channel: state });

    // браузер мог уже поставить событие open в очередь — захватываем хендлер
    const lateOpen = state.onopen;

    meta.onopen();
    meta.onclose(); // peer закрыт до открытия state

    // _closePeer снял обработчики каналов, а guard гасит поздний вызов
    expect(state.onopen).toBeNull();
    lateOpen();

    expect(controller.open).not.toHaveBeenCalled();
    expect(mgr.peerCount).toBe(0);
  });

  it('сбой SDP-обмена не оставляет осиротевшего peer', async () => {
    pc.setRemoteDescription.mockRejectedValue(new Error('bad sdp'));

    await mgr.onOffer({ clientId: 'c1', sdp: { type: 'offer' } });

    expect(signaling.sendAnswer).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(mgr.peerCount).toBe(0);
  });

  it('_closePeer снимает обработчики каналов', async () => {
    const { meta, state } = await connectPeer('c1');

    pc.connectionState = 'failed';
    pc.onconnectionstatechange();

    expect(meta.onmessage).toBeNull();
    expect(meta.onclose).toBeNull();
    expect(state.onmessage).toBeNull();
    expect(state.onclose).toBeNull();
  });
});
