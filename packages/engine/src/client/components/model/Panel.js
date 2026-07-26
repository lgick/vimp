import Publisher from '../../../lib/Publisher.js';

// Singleton PanelModel

let panelModel;

export default class PanelModel {
  // keys — маппинг wire-ключей на имена полей (h → health, wa → activeWeapon);
  // fields — схема полей игры: форматирование задаёт type, а не имя поля
  constructor(keys, fields = []) {
    if (panelModel) {
      return panelModel;
    }

    panelModel = this;

    this._keys = keys;
    this._types = Object.fromEntries(
      fields.map(field => [field.name, field.type]),
    );
    this.publisher = new Publisher();
  }

  // обновляет данные панели пользователя
  // данные - это массив из строковых значение с разделителем ":"
  // [‘h:100’, ’t:54’, ’w1:39’, ‘wa:w1’]
  // или без разделителя:
  // [’t:54’, 't' ’w1’, ‘w2’]
  // первое значение - название поля или действие:
  // h - health
  // t - time
  // w - weapon
  // wa - active weapon (действие сменить активное оружие)
  // если второе значение есть, оно передаётся в поле,
  // если нет, то поле скрывается
  update(arr) {
    for (let i = 0, len = arr.length; i < len; i += 1) {
      const data = arr[i].split(':');
      const name = this._keys[data[0]]; // h -> health, wa -> activeWeapon
      let value = data[1];

      if (!value) {
        this.publisher.emit('hide', name);
      } else {
        // если смена активного оружия
        // value здесь - это ключ оружия, например 'w1'
        // нужно получить имя панели, например 'bullet'
        if (name === 'activeWeapon') {
          this.publisher.emit('activeWeapon', this._keys[value]);
        } else {
          value = Number(value);

          if (this._types[name] === 'time') {
            value = this.formatTime(value);
          }

          this.publisher.emit('data', { name, value });
        }
      }
    }
  }

  // задаёт формат времени
  formatTime(time) {
    const min = ~~(time / 60);
    const sec = time % 60 || 0;

    return sec < 10 ? `${min}:0${sec}` : `${min}:${sec}`;
  }
}
