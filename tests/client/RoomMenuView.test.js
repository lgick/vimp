import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';
import lobbyConfig from '../../packages/engine/src/config/lobby.js';

// RoomMenuView — синглтон, перезагружаем модуль для изоляции
let RoomMenuView;

const config = lobbyConfig.roomMenu;

beforeEach(async () => {
  vi.resetModules();
  RoomMenuView = (
    await import('../../packages/engine/src/client/components/view/RoomMenu.js')
  ).default;
  document.body.innerHTML = `
    <div id="panel"><h1 id="logo"></h1><table></table></div>
    <div id="room-menu" style="display:none">
      <input id="room-menu-toggle" type="button" />
      <div id="room-menu-list" style="display:none">
        <input id="room-menu-handover" type="button" style="display:none" />
        <input id="room-menu-leave" type="button" />
        <div id="room-menu-status" style="display:none"></div>
      </div>
    </div>
  `;
});

const byId = id => document.getElementById(id);

const STATE = {
  visible: true,
  leave: { visible: true, disabled: false },
  handover: { visible: false, disabled: false },
  status: null,
};

describe('RoomMenuView', () => {
  it('placeInPanel: в панель после таблицы и обратно в угол', () => {
    const view = new RoomMenuView({ publisher: new Publisher() }, config);

    expect(byId('room-menu').parentElement).toBe(document.body);
    view.placeInPanel(true);
    expect(byId('room-menu').parentElement).toBe(byId('panel'));
    expect(byId('panel').lastElementChild).toBe(byId('room-menu'));
    // игра без панели в initIdList — кнопка остаётся в углу
    view.placeInPanel(false);
    expect(byId('room-menu').parentElement).toBe(document.body);
  });

  it('state: видимость меню и пунктов, блокировка, статус', () => {
    const model = { publisher: new Publisher() };

    new RoomMenuView(model, config);
    model.publisher.emit('state', STATE);
    expect(byId('room-menu').style.display).toBe('block');
    expect(byId('room-menu-leave').style.display).toBe('block');
    expect(byId('room-menu-handover').style.display).toBe('none');
    expect(byId('room-menu-status').style.display).toBe('none');

    model.publisher.emit('state', {
      ...STATE,
      leave: { visible: true, disabled: true },
      handover: { visible: true, disabled: true },
      status: 'Handing over…',
    });
    expect(byId('room-menu-handover').style.display).toBe('block');
    expect(byId('room-menu-handover').disabled).toBe(true);
    expect(byId('room-menu-leave').disabled).toBe(true);
    expect(byId('room-menu-status').style.display).toBe('block');
    expect(byId('room-menu-status').textContent).toBe('Handing over…');

    model.publisher.emit('state', { ...STATE, visible: false });
    expect(byId('room-menu').style.display).toBe('none');
  });

  it('open раскрывает список', () => {
    const model = { publisher: new Publisher() };

    new RoomMenuView(model, config);
    model.publisher.emit('open', true);
    expect(byId('room-menu-list').style.display).toBe('block');
    model.publisher.emit('open', false);
    expect(byId('room-menu-list').style.display).toBe('none');
  });

  it('клики эмитят toggle, leave, handover', () => {
    const model = { publisher: new Publisher() };
    const view = new RoomMenuView(model, config);
    const events = [];

    for (const type of ['toggle', 'leave', 'handover']) {
      view.publisher.on(type, () => events.push(type));
    }

    byId('room-menu-toggle').click();
    byId('room-menu-leave').click();
    byId('room-menu-handover').click();

    expect(events).toEqual(['toggle', 'leave', 'handover']);
  });
});
