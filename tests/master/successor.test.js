import { describe, it, expect } from 'vitest';
import {
  iceTier,
  isCandidate,
  pickSuccessor,
} from '../../packages/engine/src/master/successor.js';

const OPTS = {
  minMemberAgeMs: 10000,
  switchRatio: 0.65,
  switchSustainMs: 30000,
};
const NOW = 100000;

// участник по умолчанию — годный кандидат
const member = (memberId, overrides = {}) => ({
  memberId,
  live: true,
  joinedAt: 0,
  score: 50,
  demotedUntil: null,
  relayPenalty: false,
  ...overrides,
  caps: {
    canHost: true,
    hidden: false,
    iceType: 'srflx',
    ...overrides.caps,
  },
});

const room = (members, overrides = {}) => ({
  hostMemberId: 'host',
  successorMemberId: null,
  challenger: null,
  members: [member('host', { score: 1 }), ...members],
  ...overrides,
});

const pick = (r, now = NOW) => pickSuccessor(r, now, OPTS);

describe('isCandidate', () => {
  it.each([
    ['хост', member('host'), false],
    ['отсоединённый', member('a', { live: false }), false],
    ['не может хостить', member('a', { caps: { canHost: false } }), false],
    ['спрятанная вкладка', member('a', { caps: { hidden: true } }), false],
    ['вошёл недавно', member('a', { joinedAt: NOW - 9999 }), false],
    ['смещён голосованием', member('a', { demotedUntil: NOW + 1 }), false],
    ['смещение истекло', member('a', { demotedUntil: NOW }), true],
    ['хост не подтвердил пира', member('a', { confirmed: false }), false],
    ['подтверждён хостом', member('a', { confirmed: true }), true],
    ['годный', member('a'), true],
  ])('%s', (_name, m, expected) => {
    expect(isCandidate(m, 'host', NOW, OPTS.minMemberAgeMs)).toBe(expected);
  });

  it('minFps (этап 9c): слабый FPS отсеивается, неизвестный — нет, allowHidden порог снимает', () => {
    const slow = member('a', { caps: { fps: 29 } });
    const fast = member('b', { caps: { fps: 30 } });
    const unknown = member('c', { caps: { fps: null } });
    const check = (m, allowHidden = false) =>
      isCandidate(m, 'host', NOW, OPTS.minMemberAgeMs, allowHidden, 30);

    expect(check(slow)).toBe(false);
    expect(check(fast)).toBe(true);
    expect(check(unknown)).toBe(true);
    expect(check(slow, true)).toBe(true);
    // без порога (старые вызовы) FPS не учитывается
    expect(isCandidate(slow, 'host', NOW, OPTS.minMemberAgeMs)).toBe(true);
  });

  it('pickSuccessor с minFps: бета со слабым FPS заменяется сразу', () => {
    const r = room(
      [
        member('slow', { score: 10, caps: { fps: 12 } }),
        member('ok', { score: 80, caps: { fps: 60 } }),
      ],
      { successorMemberId: 'slow' },
    );

    expect(pickSuccessor(r, NOW, { ...OPTS, minFps: 30 })).toEqual({
      successorMemberId: 'ok',
      challenger: null,
    });
  });

  it('allowHidden (аварийный промоушен, этап 7): спрятанная вкладка — кандидат', () => {
    const hidden = member('a', { caps: { hidden: true } });

    expect(isCandidate(hidden, 'host', NOW, OPTS.minMemberAgeMs, true)).toBe(
      true,
    );
    expect(
      pickSuccessor(room([hidden]), NOW, { ...OPTS, allowHidden: true })
        .successorMemberId,
    ).toBe('a');
  });
});

describe('iceTier', () => {
  it.each([
    ['host', 0],
    ['srflx', 0],
    ['prflx', 0],
    [null, 1],
    ['relay', 2],
  ])('%s → %i', (iceType, tier) => {
    expect(iceTier(member('a', { caps: { iceType } }))).toBe(tier);
  });

  it('штраф после неудачного промоушена — ярус relay', () => {
    expect(iceTier(member('a', { relayPenalty: true }))).toBe(2);
  });
});

describe('pickSuccessor', () => {
  it('некого — null', () => {
    expect(pick(room([]))).toEqual({
      successorMemberId: null,
      challenger: null,
    });
    expect(
      pick(room([member('a', { caps: { canHost: false } })])),
    ).toMatchObject({ successorMemberId: null });
  });

  it('лучший score внутри яруса, при равенстве — раньше вошедший', () => {
    expect(
      pick(room([member('a', { score: 80 }), member('b', { score: 30 })])),
    ).toMatchObject({ successorMemberId: 'b' });
    expect(
      pick(
        room([
          member('late', { joinedAt: 500 }),
          member('early', { joinedAt: 100 }),
        ]),
      ),
    ).toMatchObject({ successorMemberId: 'early' });
  });

  it('без замера RTT — хуже любого измеренного', () => {
    expect(
      pick(room([member('a', { score: null }), member('b', { score: 900 })])),
    ).toMatchObject({ successorMemberId: 'b' });
  });

  it('relay с лучшим RTT проигрывает srflx с худшим', () => {
    expect(
      pick(
        room([
          member('relay', { score: 10, caps: { iceType: 'relay' } }),
          member('srflx', { score: 300 }),
        ]),
      ),
    ).toMatchObject({ successorMemberId: 'srflx' });
  });

  it('неизвестный тип между прямым и relay', () => {
    expect(
      pick(
        room([
          member('relay', { score: 10, caps: { iceType: 'relay' } }),
          member('unknown', { score: 300, caps: { iceType: null } }),
        ]),
      ),
    ).toMatchObject({ successorMemberId: 'unknown' });
  });

  it('только relay — всё равно выбирается', () => {
    expect(
      pick(room([member('relay', { caps: { iceType: 'relay' } })])),
    ).toMatchObject({ successorMemberId: 'relay' });
  });

  it('штраф relay уступает прямому кандидату', () => {
    expect(
      pick(
        room([
          member('penalized', { score: 5, relayPenalty: true }),
          member('b', { score: 200 }),
        ]),
      ),
    ).toMatchObject({ successorMemberId: 'b' });
  });

  it('бета перестала быть кандидатом — сразу лучший', () => {
    const result = pick(
      room(
        [member('a', { caps: { hidden: true } }), member('b', { score: 100 })],
        { successorMemberId: 'a' },
      ),
    );

    expect(result).toEqual({ successorMemberId: 'b', challenger: null });
  });

  describe('гистерезис', () => {
    const members = (bScore = 30) => [
      member('a', { score: 100 }),
      member('b', { score: bScore }),
    ];

    it('незаметно лучший кандидат бету не меняет', () => {
      expect(pick(room(members(70), { successorMemberId: 'a' }))).toEqual({
        successorMemberId: 'a',
        challenger: null,
      });
    });

    it('заметно лучший — только продержавшись switchSustainMs', () => {
      let state = room(members(), { successorMemberId: 'a' });
      let now = NOW;

      const step = dt => {
        now += dt;

        const result = pick(state, now);

        state = {
          ...state,
          successorMemberId: result.successorMemberId,
          challenger: result.challenger,
        };

        return result;
      };

      expect(step(0)).toEqual({
        successorMemberId: 'a',
        challenger: { memberId: 'b', since: NOW },
      });
      expect(step(15000)).toMatchObject({ successorMemberId: 'a' });
      expect(step(14999)).toMatchObject({ successorMemberId: 'a' });
      expect(step(1)).toEqual({ successorMemberId: 'b', challenger: null });
    });

    it('перевес пропал — отсчёт сбрасывается', () => {
      const first = pick(room(members(), { successorMemberId: 'a' }));
      const lost = pick(
        room(members(80), {
          successorMemberId: 'a',
          challenger: first.challenger,
        }),
        NOW + 40000,
      );

      expect(lost).toEqual({ successorMemberId: 'a', challenger: null });
    });

    it('лучший ярус связности — тоже перевес', () => {
      const result = pick(
        room(
          [
            member('relay', { score: 10, caps: { iceType: 'relay' } }),
            member('b', { score: 300 }),
          ],
          {
            successorMemberId: 'relay',
            challenger: { memberId: 'b', since: NOW - 30000 },
          },
        ),
      );

      expect(result).toEqual({ successorMemberId: 'b', challenger: null });
    });
  });
});
