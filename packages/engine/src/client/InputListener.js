import Publisher from '../lib/Publisher.js';

let inputListener;

export default class InputListener {
  constructor() {
    if (inputListener) {
      return inputListener;
    }

    inputListener = this;

    this.publisher = new Publisher();

    window.addEventListener('keydown', event =>
      this.publisher.emit('keyDown', event),
    );

    window.addEventListener('keyup', event =>
      this.publisher.emit('keyUp', event),
    );

    const emitMouse = () => this.publisher.emit('mouseAction');

    window.addEventListener('mouseup', emitMouse);
    window.addEventListener('mousedown', emitMouse);
    window.addEventListener('mousemove', emitMouse);

    // указатель: один набор Pointer Events закрывает мышь, палец и стилус —
    // это и есть поддержка смартфона. Экранные координаты сырые: в мировые
    // их переводит CanvasManager, у которого камера и масштаб полотна.
    // Безаргументный mouseAction выше остаётся: на нём висит скрытие курсора
    const emitPointer = type => event =>
      this.publisher.emit('pointerAction', {
        type,
        x: event.clientX,
        y: event.clientY,
      });

    window.addEventListener('pointerdown', emitPointer('down'));
    window.addEventListener('pointermove', emitPointer('move'));
    window.addEventListener('pointerup', emitPointer('up'));
    // палец, уведённый системным жестом, up не даёт — без этого змейка
    // осталась бы разогнанной с «прижатым» указателем
    window.addEventListener('pointercancel', emitPointer('up'));

    window.addEventListener('resize', () =>
      this.publisher.emit('resize', {
        width: innerWidth,
        height: innerHeight,
      }),
    );
  }
}
