import { describe, it, expect } from 'vitest';

import {
  parseVersion,
  isVersion,
  compareVersions,
  increment,
  levelForBreaking,
} from '../../../scripts/release/semver.js';

describe('semver', () => {
  it('разбирает и валидирует версию', () => {
    expect(parseVersion('0.6.0')).toEqual({ major: 0, minor: 6, patch: 0 });
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('minor')).toBe(false);
    expect(() => parseVersion('x')).toThrow();
  });

  it('сравнивает версии по компонентам', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('инкрементирует по уровню', () => {
    expect(increment('0.6.0', 'patch')).toBe('0.6.1');
    expect(increment('0.6.1', 'minor')).toBe('0.7.0');
    expect(increment('0.6.1', 'major')).toBe('1.0.0');
    expect(() => increment('0.6.1', 'huge')).toThrow();
  });

  it('в 0.x ломающее изменение — это minor, а не major', () => {
    expect(levelForBreaking('0.2.1')).toBe('minor');
    expect(levelForBreaking('1.4.0')).toBe('major');
  });
});
