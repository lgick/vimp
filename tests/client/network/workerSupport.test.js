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

  it('пробный Worker создаётся из blob:-URL, а не data: (CSP worker-src не разрешает data:)', () => {
    const probeUrl = 'blob:mock-probe-url';
    const createObjectURL = vi.fn(() => probeUrl);
    const revokeObjectURL = vi.fn();
    let receivedUrl;

    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url, options) {
          receivedUrl = url;
          void options.type;
        }

        terminate() {}
      },
    );

    expect(supportsModuleWorker()).toBe(true);
    expect(receivedUrl).toBe(probeUrl);
    expect(receivedUrl.startsWith('data:')).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith(probeUrl);
  });
});
