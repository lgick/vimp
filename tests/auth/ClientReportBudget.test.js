import ClientReportBudget from '../../packages/auth/src/lib/ClientReportBudget.js';

const HOUR_MS = 60 * 60 * 1000;

function createBudget(overrides = {}) {
  const clock = { t: Date.parse('2026-09-27T10:00:00Z') };
  const budget = new ClientReportBudget({
    newPerIpPerHour: 10,
    newGlobalPerHour: 25,
    maxRows: 1000,
    now: () => clock.t,
    ...overrides,
  });

  return { budget, clock };
}

describe('ClientReportBudget', () => {
  it('бюджет по IP исчерпывается и не трогает другой IP', () => {
    const { budget } = createBudget();

    expect(budget.take('1.1.1.1', 8)).toBe(8);
    expect(budget.take('1.1.1.1', 5)).toBe(2);
    expect(budget.take('1.1.1.1', 1)).toBe(0);
    expect(budget.take('2.2.2.2', 5)).toBe(5);
    expect(budget.drainThrottled()).toEqual({ reason: 'ip', skipped: 4 });
  });

  it('общий бюджет режет всех', () => {
    const { budget } = createBudget();

    budget.take('1.1.1.1', 10);
    budget.take('2.2.2.2', 10);

    expect(budget.take('3.3.3.3', 10)).toBe(5);
    expect(budget.take('4.4.4.4', 1)).toBe(0);
    expect(budget.drainThrottled()).toEqual({ reason: 'global', skipped: 6 });
  });

  it('потолок maxRows после setRows режет и растёт от take', () => {
    const { budget } = createBudget({ maxRows: 100 });

    budget.setRows(95);

    expect(budget.take('1.1.1.1', 3)).toBe(3);
    expect(budget.take('2.2.2.2', 5)).toBe(2);
    expect(budget.take('3.3.3.3', 1)).toBe(0);
    expect(budget.drainThrottled()).toEqual({ reason: 'maxRows', skipped: 4 });
  });

  it('смена часа обнуляет счётчики, но не строки', () => {
    const { budget, clock } = createBudget({ maxRows: 15 });

    expect(budget.take('1.1.1.1', 10)).toBe(10);
    expect(budget.take('1.1.1.1', 1)).toBe(0);

    clock.t += HOUR_MS;

    expect(budget.take('1.1.1.1', 10)).toBe(5);
  });

  it('drainThrottled отдаёт сумму и причину и обнуляется', () => {
    const { budget } = createBudget();

    expect(budget.drainThrottled()).toEqual({ reason: null, skipped: 0 });

    budget.take('1.1.1.1', 12);
    budget.take('1.1.1.1', 3);

    expect(budget.drainThrottled()).toEqual({ reason: 'ip', skipped: 5 });
    expect(budget.drainThrottled()).toEqual({ reason: null, skipped: 0 });
  });
});
