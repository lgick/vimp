import { describe, it, expect, beforeEach, vi } from 'vitest';

// RoomMenuModel — синглтон, перезагружаем модуль для изоляции
let RoomMenuModel;

beforeEach(async () => {
  vi.resetModules();
  RoomMenuModel = (
    await import('../../packages/engine/src/client/components/model/RoomMenu.js')
  ).default;
});

const LINK = 'https://vimp.dev/#/tanks/k7m2qx3a';
const HOST = { role: 'host', othersPresent: true, hasSuccessor: true };

describe('RoomMenuModel', () => {
  it('setLink: пустая ссылка — null, меню скрыто', () => {
    const model = new RoomMenuModel();
    const states = [];

    model.publisher.on('state', state => states.push(state.visible));
    model.setLink(LINK);
    model.setLink('');

    expect(states).toEqual([true, false]);
    expect(model.getLink()).toBeNull();
  });

  it('без ссылки меню не открывается; снятие ссылки закрывает его', () => {
    const model = new RoomMenuModel();
    const opens = [];

    model.publisher.on('open', open => opens.push(open));
    model.toggle();
    model.setLink(LINK);
    model.toggle();
    model.setLink(null);

    expect(opens).toEqual([true, false]);
  });

  it('«Leave server» — у всех в комнате', () => {
    const model = new RoomMenuModel();

    model.setLink(LINK);
    model.setRole({ role: 'guest' });

    expect(model.getState()).toMatchObject({
      leave: { visible: true, disabled: false },
      handover: { visible: false },
      status: null,
    });
  });

  it('«Hand over host» — только хосту, при других людях и назначенной бете', () => {
    const model = new RoomMenuModel();
    const handover = () => model.getState().handover.visible;

    model.setLink(LINK);
    model.setRole(HOST);
    expect(handover()).toBe(true);

    model.setRole({ ...HOST, hasSuccessor: false });
    expect(handover()).toBe(false);

    model.setRole({ ...HOST, othersPresent: false });
    expect(handover()).toBe(false);

    model.setRole({ ...HOST, role: 'guest' });
    expect(handover()).toBe(false);

    model.setRole(HOST);
    model.setLink(null);
    expect(handover()).toBe(false);
  });

  it('пока идёт передача — пункты заблокированы, на месте статус', () => {
    const model = new RoomMenuModel();

    model.setLink(LINK);
    model.setRole(HOST);
    model.setHandoff('pending');
    expect(model.getState()).toMatchObject({
      leave: { disabled: true },
      handover: { disabled: true },
      status: 'Handing over…',
    });

    model.setHandoff('slow');
    expect(model.getState().status).toBe('Slow connection…');
    expect(model.getState().leave.disabled).toBe(true);

    model.setHandoff(null);
    expect(model.getState()).toMatchObject({
      leave: { disabled: false },
      status: null,
    });
  });

  it('ошибка передачи не блокирует пункты и забывается закрытием меню', () => {
    const model = new RoomMenuModel();

    model.setLink(LINK);
    model.setRole(HOST);
    model.setOpen(true);
    model.setHandoff('failed');
    expect(model.getState()).toMatchObject({
      handover: { disabled: false },
      status: 'Host handover failed',
    });

    model.setOpen(false);
    expect(model.getState().status).toBeNull();
  });
});
