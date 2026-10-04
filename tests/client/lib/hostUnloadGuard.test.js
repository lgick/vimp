import { describe, it, expect, beforeEach, vi } from 'vitest';
import HostUnloadGuard from '../../../packages/engine/src/client/lib/hostUnloadGuard.js';

// Защита вкладки хоста (host-migration этап 8.4): beforeunload — только у
// хоста при других людях в комнате; pagehide — host_leaving хостом, LEAVE
// гостем; exit() («Leave server») снимает и то, и другое.

let target;
let onHostLeave;
let onGuestLeave;

const create = () => new HostUnloadGuard({ target, onHostLeave, onGuestLeave });

const fireBeforeUnload = () => {
  const event = new Event('beforeunload', { cancelable: true });

  target.dispatchEvent(event);

  return event;
};

beforeEach(() => {
  target = new EventTarget();
  onHostLeave = vi.fn();
  onGuestLeave = vi.fn();
});

describe('HostUnloadGuard: beforeunload', () => {
  it('хост при других людях — диалог закрытия', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: true });

    expect(guard.armed).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it('хост один, гость, вне комнаты — без диалога', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: false });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    guard.update({ role: 'guest', othersPresent: true });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    guard.update({ role: null });
    expect(guard.armed).toBe(false);
  });

  it('потеря роли и уход последнего гостя снимают диалог', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: true });
    guard.update({ role: 'host', othersPresent: false });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    guard.update({ role: 'host', othersPresent: true });
    guard.update({ role: 'guest', othersPresent: true });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('exit() — диалог снят навсегда', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: true });
    guard.exit();
    guard.update({ role: 'host', othersPresent: true });

    expect(guard.armed).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});

describe('HostUnloadGuard: pagehide', () => {
  it('хост — onHostLeave (host_leaving), один раз', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: false });
    target.dispatchEvent(new Event('pagehide'));
    target.dispatchEvent(new Event('pagehide'));

    expect(onHostLeave).toHaveBeenCalledOnce();
    expect(onGuestLeave).not.toHaveBeenCalled();
  });

  it('гость — onGuestLeave, хостовое не шлётся', () => {
    const guard = create();

    guard.update({ role: 'guest' });
    target.dispatchEvent(new Event('pagehide'));

    expect(onGuestLeave).toHaveBeenCalledOnce();
    expect(onHostLeave).not.toHaveBeenCalled();
  });

  it('вне комнаты и после exit() — ничего', () => {
    create();
    target.dispatchEvent(new Event('pagehide'));

    const guard = create();

    guard.update({ role: 'host', othersPresent: true });
    guard.exit();
    target.dispatchEvent(new Event('pagehide'));

    expect(onHostLeave).not.toHaveBeenCalled();
    expect(onGuestLeave).not.toHaveBeenCalled();
  });

  it('destroy снимает обработчики', () => {
    const guard = create();

    guard.update({ role: 'host', othersPresent: true });
    guard.destroy();
    target.dispatchEvent(new Event('pagehide'));

    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    expect(onHostLeave).not.toHaveBeenCalled();
  });
});
