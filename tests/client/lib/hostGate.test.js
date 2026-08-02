import { describe, it, expect } from 'vitest';
import { getHostGateState } from '../../../packages/engine/src/client/lib/hostGate.js';

describe('hostGate.getHostGateState', () => {
  it('не блокирует, когда выбранная игра совпадает с активной', () => {
    const state = getHostGateState('tanks', { id: 'tanks', title: 'Tanks' });

    expect(state).toEqual({ disabled: false, title: '' });
  });

  it('блокирует и объясняет причину, когда выбрана другая игра', () => {
    const state = getHostGateState('chess', { id: 'tanks', title: 'Tanks' });

    expect(state.disabled).toBe(true);
    expect(state.title).toBe('Hosting Tanks — switch back to create a server');
  });
});
