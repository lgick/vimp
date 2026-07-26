import { describe, it, expect, beforeEach, vi } from 'vitest';
import SocketManager from '../../packages/engine/src/host/meta/SocketManager.js';

const ports = {
  CONFIG_DATA: 0,
  AUTH_DATA: 1,
  AUTH_RESULT: 2,
  MAP_DATA: 3,
  FIRST_SHOT_DATA: 4,
  SHOT_DATA: 5,
  SOUND_DATA: 6,
  GAME_INFORM_DATA: 7,
  TECH_INFORM_DATA: 8,
  MISC: 9,
  PING: 10,
  CLEAR: 11,
  CONSOLE: 12,
  PANEL_DATA: 13,
  STAT_DATA: 14,
  CHAT_DATA: 15,
  VOTE_DATA: 16,
  KEYSET_DATA: 17,
};

const makeSocket = () => ({
  send: vi.fn(),
  sendBinary: vi.fn(),
  close: vi.fn(),
});

let sm;
let socket;

// игровая параметризация (в проде — из конфига игры)
const soundCues = {
  roundStart: 'roundStart',
  victory: 'victory',
  defeat: 'defeat',
  frag: 'frag',
  death: 'gameOver',
};

beforeEach(() => {
  sm = new SocketManager(ports, { soundCues, initialVote: 'teamChange' });
  socket = makeSocket();
  sm.addUser('s1', socket);
});

describe('SocketManager: маршрутизация портов', () => {
  it('sendConfig уходит на порт CONFIG_DATA', () => {
    sm.sendConfig('s1', { a: 1 });
    expect(socket.send).toHaveBeenCalledWith(0, { a: 1 }, true);
  });

  it('sendPing уходит на порт PING ненадёжным каналом', () => {
    sm.sendPing('s1', 7);
    expect(socket.send).toHaveBeenCalledWith(10, 7, false);
  });

  it('sendName формирует команду замены имени', () => {
    sm.sendName('s1', 'Bob');
    expect(socket.send).toHaveBeenCalledWith(9, {
      key: 'localstorageNameReplace',
      value: 'Bob',
    }, true);
  });

  it('sendClear со списком и без', () => {
    sm.sendClear('s1', ['c1']);
    expect(socket.send).toHaveBeenCalledWith(11, ['c1'], true);

    socket.send.mockClear();
    sm.sendClear('s1');
    // без данных второй аргумент явно undefined
    expect(socket.send).toHaveBeenCalledWith(11, undefined, true);
  });
});

describe('SocketManager: технические сообщения', () => {
  it('sendTechInform по ключу подставляет код', () => {
    sm.sendTechInform('s1', 'fullServer');
    expect(socket.send).toHaveBeenCalledWith(8, [0], true);
  });

  it('sendTechInform с массивом параметров', () => {
    sm.sendTechInform('s1', 'kickIdle', ['reason']);
    expect(socket.send).toHaveBeenCalledWith(8, [3, ['reason']], true);
  });

  it('close с ключом отправляет код закрытия и данные', () => {
    sm.close('s1', 4000, 'kickForMaxLatency');
    expect(socket.close).toHaveBeenCalledWith(4000, [4]);
  });

  it('close без ключа закрывает без данных', () => {
    sm.close('s1', 1000);
    expect(socket.close).toHaveBeenCalledWith(1000, undefined);
  });
});

describe('SocketManager: игровые сообщения', () => {
  it('sendGameInform по ключу подставляет код', () => {
    sm.sendGameInform('s1', 'roundStart');
    expect(socket.send).toHaveBeenCalledWith(7, [1], true);
  });

  it('sendGameInform с массивом параметров', () => {
    sm.sendGameInform('s1', 'winnerTeam', ['team1']);
    expect(socket.send).toHaveBeenCalledWith(7, [0, ['team1']], true);
  });

  it('sendRoundEnd с победителем включает команду', () => {
    sm.sendRoundEnd('s1', 'team1');
    expect(socket.send).toHaveBeenCalledWith(7, [0, ['team1']], true);
  });

  it('sendRoundEnd без победителя — gameOver', () => {
    sm.sendRoundEnd('s1');
    expect(socket.send).toHaveBeenCalledWith(7, [2], true);
  });

  it('sendFirstShot шлёт snapshot, статистику, панель и keySet своими каналами', () => {
    const game = { getPlayersData: () => ({ p: 1 }) };
    const panel = { getEmptyPanel: () => ['t:120'] };
    const stat = { getFull: () => [[], []] };
    sm.injectServices(game, panel, stat);

    sm.sendFirstShot('s1');

    // snapshot-кадр на FIRST_SHOT_DATA: [gameSnapshot, camera=0, serverTime, seq=0]
    const firstShotCall = socket.send.mock.calls.find(c => c[0] === 4);
    expect(firstShotCall[1][0]).toEqual({ p: 1 });
    expect(firstShotCall[1][1]).toBe(0);
    expect(typeof firstShotCall[1][2]).toBe('number');
    expect(firstShotCall[1][3]).toBe(0);

    expect(socket.send).toHaveBeenCalledWith(14, [[], []], true); // stat
    expect(socket.send).toHaveBeenCalledWith(13, ['t:120'], true); // panel
    expect(socket.send).toHaveBeenCalledWith(17, 0, true); // keySet (наблюдатель)
  });
});

describe('SocketManager: простые отправители', () => {
  it('sendAuthData / sendAuthResult', () => {
    sm.sendAuthData('s1', { fields: 1 });
    expect(socket.send).toHaveBeenCalledWith(1, { fields: 1 }, true);

    sm.sendAuthResult('s1', null);
    expect(socket.send).toHaveBeenCalledWith(2, null, true);
  });

  it('sendMap уходит на порт MAP_DATA', () => {
    sm.sendMap('s1', { map: 1 });
    expect(socket.send).toHaveBeenCalledWith(3, { map: 1 }, true);
  });

  it('sendShot передаёт бинарный кадр и флаг reliable через sendBinary', () => {
    const frame = new ArrayBuffer(8);

    sm.sendShot('s1', frame, true);
    expect(socket.sendBinary).toHaveBeenCalledWith(frame, true);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('sendFirstVote шлёт initialVote из конфига на VOTE_DATA', () => {
    sm.sendFirstVote('s1');
    expect(socket.send).toHaveBeenCalledWith(16, { name: 'teamChange' }, true);
  });

  it('sendFirstVote без initialVote ничего не шлёт', () => {
    const bare = new SocketManager(ports);

    bare.addUser('s2', socket);
    bare.sendFirstVote('s2');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('канальные отправители уходят на свои порты', () => {
    sm.sendPanel('s1', ['p:1']);
    expect(socket.send).toHaveBeenCalledWith(13, ['p:1'], true);

    sm.sendStat('s1', [[], []]);
    expect(socket.send).toHaveBeenCalledWith(14, [[], []], true);

    sm.sendChat('s1', ['msg']);
    expect(socket.send).toHaveBeenCalledWith(15, ['msg'], true);

    sm.sendVote('s1', { name: 'v' });
    expect(socket.send).toHaveBeenCalledWith(16, { name: 'v' }, true);

    sm.sendKeySet('s1', 1);
    expect(socket.send).toHaveBeenCalledWith(17, 1, true);
  });

  it('sendPlayerDefaultShot шлёт полную панель и keySet 1', () => {
    sm.injectServices(null, { getFullPanel: () => ['p'] }, null);
    sm.sendPlayerDefaultShot('s1', 'g1');
    expect(socket.send).toHaveBeenCalledWith(13, ['p'], true); // panel
    expect(socket.send).toHaveBeenCalledWith(17, 1, true); // keySet (игрок)
  });

  it('sendSpectatorDefaultShot шлёт пустую панель и keySet 0', () => {
    sm.injectServices(null, { getEmptyPanel: () => ['e'] }, null);
    sm.sendSpectatorDefaultShot('s1');
    expect(socket.send).toHaveBeenCalledWith(13, ['e'], true); // panel
    expect(socket.send).toHaveBeenCalledWith(17, 0, true); // keySet (наблюдатель)
  });

  it('sendSoundCue маппит движковое событие на звук игры (SOUND_DATA)', () => {
    sm.sendSoundCue('s1', 'victory');
    expect(socket.send).toHaveBeenCalledWith(6, 'victory', true);

    sm.sendSoundCue('s1', 'defeat');
    expect(socket.send).toHaveBeenCalledWith(6, 'defeat', true);

    sm.sendSoundCue('s1', 'frag');
    expect(socket.send).toHaveBeenCalledWith(6, 'frag', true);

    // движковое событие и имя звука игры различаются
    sm.sendSoundCue('s1', 'death');
    expect(socket.send).toHaveBeenCalledWith(6, 'gameOver', true);
  });

  it('sendSoundCue игнорирует незамапленное событие', () => {
    sm.sendSoundCue('s1', 'unknownCue');
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('SocketManager: жизненный цикл соединений', () => {
  it('removeUser отключает отправку и логирует попытку', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sm.removeUser('s1');

    sm.sendConfig('s1', {});
    expect(socket.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('отправка несуществующему сокету не падает', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => sm.sendConfig('ghost', {})).not.toThrow();
    warn.mockRestore();
  });

  it('бинарная отправка несуществующему сокету не падает', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => sm.sendShot('ghost', new ArrayBuffer(4))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
