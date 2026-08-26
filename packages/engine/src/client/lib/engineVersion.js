// Версия npm-пакета движка, запечённая в бандл на сборке: сети для неё нет
// (у мастера нет version-эндпоинта), а лобби обязано показывать версию того
// кода, который сейчас исполняется, а не того, что развёрнут на сервере.
//
// Модуль лежит в client/lib, а не в src/config: config/* импортирует мастер
// под Node, а сюда тянется package.json пакета — он нужен только браузерному
// бандлу (в npm-тарболле vimp-engine package.json есть всегда, поэтому
// standalone SDK собирается у игры тем же импортом).
import pkg from '../../../package.json' with { type: 'json' };
import { homepageOf } from '../../lib/packageLink.js';

export const ENGINE_VERSION = pkg.version;

// метаданные для ссылки в футере лобби — та же форма, что мастер отдаёт про
// пакет игры (GameCatalog), чтобы оба футера строил один resolvePackageLink
export const ENGINE_PACKAGE = {
  name: pkg.name,
  homepage: homepageOf(pkg),
};
