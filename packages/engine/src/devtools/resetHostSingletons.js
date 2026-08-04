import { resetTimerManager } from '../host/meta/modules/TimerManager.js';
import { resetPanel } from '../host/meta/modules/Panel.js';
import { resetStat } from '../host/meta/modules/Stat.js';
import { resetVote } from '../host/meta/modules/Vote.js';
import { resetChat } from '../host/meta/modules/chat/index.js';

// Мета-модули хоста — синглтоны на модуль: в браузерной вкладке матч всегда
// один, и второй `new TimerManager(...)` молча возвращает первый. Для
// headless-прогона это ловушка: второй прогон в том же процессе получил бы
// таймеры первого (со ссылками на его HostGame и на уже выброшенные
// виртуальные часы) и не сделал бы ни одного тика — молча.
//
// Самопроверка детерминизма прогоняет сценарий дважды подряд, поэтому
// изоляция обязана быть явной.
export function resetHostSingletons() {
  resetTimerManager();
  resetPanel();
  resetStat();
  resetVote();
  resetChat();
}

export default resetHostSingletons;
