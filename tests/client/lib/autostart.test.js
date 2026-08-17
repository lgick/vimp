import { describe, it, expect, vi } from 'vitest';
import createAutostart from '../../../packages/engine/src/client/lib/autostart.js';

// Автостарт solo-режима (Этап 2 плана standalone-sdk). Порядок обязателен:
// участник входит наблюдателем, и чат-команда игры (спавн ботов) будет
// отбита, пока не отвечен initialVote.

const makeRecorder = () => {
  const stream = [];

  return {
    stream,
    sendVote: data => stream.push(['vote', data]),
    sendCommand: message => stream.push(['chat', message]),
  };
};

describe('createAutostart', () => {
  it('голоса уходят строго раньше чат-команд', () => {
    const { stream, sendVote, sendCommand } = makeRecorder();
    let task = null;

    const start = createAutostart({
      votes: [['teamChange', 'team1']],
      commands: ['/bot 4', '/bot 2 team2'],
      sendVote,
      sendCommand,
      schedule: fn => {
        task = fn;
      },
    });

    start();

    // ничего не отправлено в том же синхронном вызове FIRST_SHOT_READY
    expect(stream).toEqual([]);

    task();

    expect(stream).toEqual([
      ['vote', ['teamChange', 'team1']],
      ['chat', '/bot 4'],
      ['chat', '/bot 2 team2'],
    ]);
  });

  it('запускается один раз: FIRST_SHOT_DATA приходит и после смены карты', () => {
    const { stream, sendVote, sendCommand } = makeRecorder();
    const schedule = vi.fn(fn => fn());

    const start = createAutostart({
      votes: [['teamChange', 'team1']],
      commands: ['/bot 1'],
      sendVote,
      sendCommand,
      schedule,
    });

    start();
    start();
    start();

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(stream).toHaveLength(2);
  });

  it('без задач не занимает кадр вовсе', () => {
    const schedule = vi.fn();

    createAutostart({
      sendVote: () => {},
      sendCommand: () => {},
      schedule,
    })();

    expect(schedule).not.toHaveBeenCalled();
  });
});
