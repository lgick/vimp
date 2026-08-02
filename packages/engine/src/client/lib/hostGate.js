// Пока хост всегда поднимает activeGameManifest (динамическая загрузка
// ClientPlugin по выбору игры отложена — граница задачи, plan/lobby-page-plan.md),
// нельзя дать создать комнату с полями формы игры, отличной от активной
// (code review lobby-page 2.1). Вынесено в чистую функцию, чтобы поведение
// было проверяемо юнит-тестом отдельно от main.js (main.js — бутстрап, тестами
// не покрывается).
export function getHostGateState(selectedGameId, activeGameManifest) {
  if (selectedGameId === activeGameManifest.id) {
    return { disabled: false, title: '' };
  }

  return {
    disabled: true,
    title: `Hosting ${activeGameManifest.title} — switch back to create a server`,
  };
}
