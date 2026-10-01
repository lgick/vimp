import { describe, it, expect } from 'vitest';
import FpsMeter from '../../../packages/engine/src/client/lib/FpsMeter.js';

const setup = () => {
  const clock = { now: 0 };
  const meter = new FpsMeter({ now: () => clock.now });
  // count кадров равномерно за ms
  const run = (count, ms) => {
    for (let i = 0; i < count; i++) {
      clock.now += ms / count;
      meter.frame();
    }
  };

  return { clock, meter, run };
};

describe('FpsMeter (этап 9c)', () => {
  it('средний FPS за окно; один медленный кадр почти не влияет', () => {
    const { clock, meter, run } = setup();

    run(599, 9950);
    clock.now += 50; // пауза сборщика мусора: кадр 50 мс
    meter.frame();

    expect(meter.sample()).toBeCloseTo(60, 0);
  });

  it('замер начинает окно заново', () => {
    const { meter, run } = setup();

    run(600, 10000);
    meter.sample();
    run(300, 10000);

    expect(meter.sample()).toBeCloseTo(30, 5);
  });

  it('кадров нет или окно короче 1 с — null', () => {
    const { clock, meter, run } = setup();

    clock.now += 10000;
    expect(meter.sample()).toBeNull();

    run(50, 900);
    expect(meter.sample()).toBeNull();
  });

  it('reset: время скрытой вкладки без кадров не в счёт', () => {
    const { clock, meter, run } = setup();

    run(60, 1000);
    clock.now += 8000; // вкладка скрыта, кадров нет
    meter.reset();
    run(120, 2000);

    expect(meter.sample()).toBeCloseTo(60, 5);
  });
});
