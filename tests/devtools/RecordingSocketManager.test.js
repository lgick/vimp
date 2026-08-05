import { describe, it, expect } from 'vitest';
import RecordingSocketManager from '../../packages/engine/src/devtools/RecordingSocketManager.js';
import wsports from '../../packages/engine/src/config/wsports.js';

// Транспорт наследует боевой SocketManager: составные отправители, нагрузка
// портов и их номера приходят из прод-кода, а не из копии. Ручная копия уже
// теряла keySet, панель и первый снапшот мира.

const services = () => ({
  game: { getPlayersData: () => ({ p: { 1: [7, 8] } }) },
  panel: {
    getEmptyPanel: () => ['h', 'w1'],
    getFullPanel: gameId => [`h:100:${gameId}`],
  },
  stat: { getFull: () => ['stat'] },
});

const make = (gameOpts = {}) => {
  const socket = new RecordingSocketManager(wsports.server, gameOpts);
  const { game, panel, stat } = services();

  socket.injectServices(game, panel, stat);

  return socket;
};

describe('RecordingSocketManager', () => {
  it('sendFirstShot раскрывается в stat + пустую панель + keySet наблюдателя', () => {
    const socket = make();

    socket.sendFirstShot('s1');

    expect(socket.frames.map(f => f.method)).toEqual([
      'sendFirstShot',
      'sendStat',
      'sendPanel',
      'sendKeySet',
    ]);
    expect(socket.framesOf('sendKeySet')[0].args[0]).toBe(0);
    expect(socket.framesOf('sendPanel')[0].args[0]).toEqual(['h', 'w1']);
  });

  it('первый кадр несёт снапшот мира, а не пустые аргументы', () => {
    const socket = make();

    socket.sendFirstShot('s1');

    const [sent] = socket.framesOf('sendFirstShot')[0].sent;

    expect(sent.port).toBe(wsports.server.FIRST_SHOT_DATA);
    expect(sent.data[0]).toEqual({ p: { 1: [7, 8] } });
  });

  it('sendPlayerDefaultShot раскрывается в полную панель + keySet игрока', () => {
    const socket = make();

    socket.sendPlayerDefaultShot('s1', 3);

    expect(socket.framesOf('sendPanel')[0].args[0]).toEqual(['h:100:3']);
    expect(socket.framesOf('sendKeySet')[0].args[0]).toBe(1);
  });

  it('sendSpectatorDefaultShot возвращает наблюдательский keySet', () => {
    const socket = make();

    socket.sendSpectatorDefaultShot('s1');

    expect(socket.framesOf('sendKeySet')[0].args[0]).toBe(0);
    expect(socket.framesOf('sendPanel')[0].args[0]).toEqual(['h', 'w1']);
  });

  it('sendRoundEnd записывается и сам, и своим игровым информером', () => {
    const socket = make();

    socket.sendRoundEnd('s1', 'team1');

    expect(socket.framesOf('sendRoundEnd')[0].args[0]).toBe('team1');
    expect(socket.framesOf('sendGameInform')[0].args[0]).toBe('winnerTeam');
  });

  it('бинарный кадр уезжает портом SHOT_DATA', () => {
    const socket = make();
    const buffer = new Uint8Array([1, 2, 3]);

    socket.sendShot('s1', buffer, false);

    const [sent] = socket.framesOf('sendShot')[0].sent;

    expect(sent.port).toBe(wsports.server.SHOT_DATA);
    expect(sent.data).toBe(buffer);
    expect(sent.reliable).toBe(false);
  });

  it('незамапленный звуковой сигнал не уезжает никуда (как в проде)', () => {
    const socket = make({ soundCues: { frag: 'boom' } });

    socket.sendSoundCue('s1', 'frag');
    socket.sendSoundCue('s1', 'death');

    const [frag, death] = socket.framesOf('sendSoundCue');

    expect(frag.sent[0].data).toBe('boom');
    expect(death.sent).toEqual([]);
  });

  it('без аргументов берёт боевые порты', () => {
    const socket = new RecordingSocketManager();

    socket.sendChat('s1', ['hi']);

    expect(socket.framesOf('sendChat')[0].sent[0].port).toBe(
      wsports.server.CHAT_DATA,
    );
  });
});
