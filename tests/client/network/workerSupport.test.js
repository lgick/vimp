import { describe, it, expect, afterEach, vi } from 'vitest';
import { supportsModuleWorker } from '../../../packages/engine/src/client/network/workerSupport.js';

// Фича-детект module Worker'ов (Этап 6.3): геттер `type` читают только
// реализации, понимающие module-воркеры

describe('workerSupport: supportsModuleWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('true, когда конструктор Worker читает опцию type', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url, options) {
          // читает type — как реализации, поддерживающие module-воркеры
          void options.type;
        }

        terminate() {}
      },
    );

    expect(supportsModuleWorker()).toBe(true);
  });

  it('false, когда конструктор Worker не читает опцию type', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {}
        terminate() {}
      },
    );

    expect(supportsModuleWorker()).toBe(false);
  });

  it('false, когда конструктор Worker бросает исключение', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker is not supported');
        }
      },
    );

    expect(supportsModuleWorker()).toBe(false);
  });
});
