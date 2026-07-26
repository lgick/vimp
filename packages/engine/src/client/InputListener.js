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

    window.addEventListener('resize', () =>
      this.publisher.emit('resize', {
        width: innerWidth,
        height: innerHeight,
      }),
    );
  }
}
