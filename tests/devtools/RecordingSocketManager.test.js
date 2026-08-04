import { describe, it, expect } from 'vitest';
import RecordingSocketManager from '../../packages/engine/src/devtools/RecordingSocketManager.js';

// Составные отправители боевого SocketManager внутри себя дёргают панель,
// статистику и keySet. Плоская запись их не раскрывала — клиент прогона
// оставался без keySet, то есть с выключенным предиктом.

const services = () => ({
  game: { getPlayersData: () => ({}) },
  panel: {
    getEmptyPanel: () => ['h', 'w1'],
    getFullPanel: gameId => [`h:100:${gameId}`],
  },
  stat: { getFull: () => ['stat'] },
});

const make = () => {
  const socket = new RecordingSocketManager();
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

  it('без инъекции сервисов не падает (тесты меты их не задают)', () => {
    const socket = new RecordingSocketManager();

    socket.sendFirstShot('s1');

    expect(socket.framesOf('sendKeySet')[0].args[0]).toBe(0);
    expect(socket.framesOf('sendPanel')[0].args[0]).toBeUndefined();
  });
});
