import gameConfig from './game.js';

// Схема авторизации фикстуры (HostPlugin.authSchema, PLAN.md §3.2) —
// зеркало vimp-tanks/src/config/auth.js с единственной моделью.
export default {
  elems: {
    authId: 'auth',
    formId: 'auth-form',
    errorId: 'auth-error',
    enterId: 'auth-enter',
    titleId: 'auth-title',
    informsId: 'auth-informs',
  },
  // собственные тексты фикстуры (Д2): каркас auth.pug нейтрален,
  // заголовок/подсказки — данные игры
  texts: {
    title: 'Mini Game Fixture',
    sections: [
      {
        heading: 'Controls',
        lines: [
          { keys: 'W, S', text: 'move' },
          { keys: 'J', text: 'fire' },
        ],
      },
    ],
  },
  params: [
    {
      name: 'model',
      value: 'm1',
      options: {
        validator: 'isValidModel',
        storage: 'model',
      },
    },
  ],
  validators: {
    isValidModel: model => model in gameConfig.parts.models,
  },
};
