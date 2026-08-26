// Версия npm-пакета движка, запечённая в бандл на сборке: сети для неё нет
// (у мастера нет version-эндпоинта), а лобби обязано показывать версию того
// кода, который сейчас исполняется, а не того, что развёрнут на сервере.
//
// Модуль лежит в client/lib, а не в src/config: config/* импортирует мастер
// под Node, а сюда тянется package.json пакета — он нужен только браузерному
// бандлу (в npm-тарболле vimp-engine package.json есть всегда, поэтому
// standalone SDK собирается у игры тем же импортом).
import pkg from '../../../package.json' with { type: 'json' };
import { resolveProjectUrl } from '../../lib/packageLink.js';

export const ENGINE_VERSION = pkg.version;

// адрес проекта для ссылки в футере лобби — то же поле, что мастер отдаёт
// про пакет игры (GameCatalog.packageUrl), чтобы оба футера строил один
// projectLink
export const ENGINE_PROJECT_URL = resolveProjectUrl(pkg);
