// Точка входа серверного процесса движка. Развилка (Этап 4 плана
// standalone-sdk): один и тот же `node src/master/main.js` поднимает либо
// лобби-мастер (комнаты, каталоги, сигналинг), либо dedicated-сервер одной
// игры. Развилка живёт здесь, а не в Dockerfile/npm-скриптах, чтобы
// CMD, `npm start`, `npm run dev` и watch-списки nodemon остались валидными.

if (process.env.VIMP_DEDICATED_GAME) {
  await import('../dedicated/main.js');
} else {
  await import('./lobby.js');
}
