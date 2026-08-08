// Учёт потери/восстановления WebGL-контекста по каждому полотну отдельно.
// Полотен несколько (игровое, радар и т.п.) — это независимые контексты, и
// браузер шлёт webglcontextrestored по каждому из них асинхронно. Общий
// булев флаг здесь не годится: перепечка ассетов в ещё мёртвый контекст
// даёт пустые текстуры, а второго шанса не будет — событие уже прошло.
// Вынесено из main.js (бутстрап тестами не покрывается), чтобы поведение
// проверялось юнит-тестом.
export function createContextTracker() {
  const lost = new Set();

  return {
    // true — рендер надо остановить (первая потеря из всех полотен)
    markLost(id) {
      if (lost.has(id)) {
        return false;
      }

      const wasAlive = lost.size === 0;

      lost.add(id);

      return wasAlive;
    },

    // true — пора пересобирать сцену: живы все контексты
    markRestored(id) {
      if (!lost.delete(id)) {
        return false;
      }

      return lost.size === 0;
    },

    isLost(id) {
      return lost.has(id);
    },

    hasLost() {
      return lost.size > 0;
    },

    reset() {
      lost.clear();
    },
  };
}
