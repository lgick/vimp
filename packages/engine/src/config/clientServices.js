import { createRegistry } from '../lib/registry.js';

// Реестр движковых сервисов клиентского пула (этап 3 плана
// plugin-forward-compat). Пул ими не исчерпывается: игра доливает туда свои
// через ClientPlugin.hooks.services(core) — движок о них не знает ничего.
//
// Реестр append-only (И1): имя, которое игра написала в
// componentDependencies, существует вечно. Ключевое поведение, на которое
// опирается совместимость: пул отдаёт ЗАПРОШЕННОЕ, а не всё подряд
// (client/providers/DependencyProvider.js), поэтому шестой сервис ничего не
// требует от старых игр — они его не просят и не получают. Незнакомое имя —
// не отказ загрузки, а undefined в парте; ловит его правило контракта C4.
export const clientServices = createRegistry('clientServices', [
  { value: 'renderer', since: 1 },
  { value: 'soundManager', since: 1 },
  // база ассетов пакета игры (`${assetsBase}img/...`)
  { value: 'assetsBase', since: 3 },
  // «свой ли это персонаж» (lib/localPlayer.js)
  { value: 'localPlayer', since: 3 },
  // места в глобальном топе (lib/accolades.js)
  { value: 'accolades', since: 4 },
]);

// плоский список имён — то, чем правило C4 проверяет componentDependencies
export const SERVICES = clientServices.values();

export default clientServices;
