import { capture, interactive } from './shell.js';
import * as ui from './ui.js';

// Логины проверяются только для тех реестров, куда реально пойдёт публикация,
// и до первой изменяющей команды: узнать об отсутствии токена после бампа
// версий и коммита — худший момент.

export async function ensureNpmLogin() {
  const first = await capture('npm', ['whoami'], { allowFailure: true });

  if (first.code === 0) {
    ui.log(`npm: вход выполнен (${first.output.trim()})`);
    return true;
  }

  ui.log('npm: вход не выполнен, запускаю npm login');
  await interactive('npm', ['login']);

  const second = await capture('npm', ['whoami'], { allowFailure: true });

  if (second.code === 0) {
    ui.log(`npm: вход выполнен (${second.output.trim()})`);
    return true;
  }

  ui.error('npm: войти не удалось');
  return false;
}

// `cargo whoami` не существует, а `cargo publish --dry-run` авторизацию не
// трогает — единственная read-only проверка, реально бьющая по токену, это
// запрос владельцев крейта.
export async function ensureCargoLogin(crate) {
  if (process.env.CARGO_REGISTRY_TOKEN) {
    ui.log('cargo: используется CARGO_REGISTRY_TOKEN');
    return true;
  }

  const first = await capture('cargo', ['owner', '--list', crate], {
    allowFailure: true,
  });

  if (first.code === 0) {
    ui.log('cargo: токен принят crates.io');
    return true;
  }

  ui.log('cargo: токен не принят, запускаю cargo login');
  await interactive('cargo', ['login']);

  const second = await capture('cargo', ['owner', '--list', crate], {
    allowFailure: true,
  });

  if (second.code === 0) {
    ui.log('cargo: токен принят crates.io');
    return true;
  }

  ui.error('cargo: войти не удалось');
  return false;
}
