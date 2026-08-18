import models from '../data/models.js';

// HostPlugin.authSchema — the entry screen the engine renders before a player
// joins (docs/ai/04-client-plugin.md § Auth screen).
//
// Three traps live in this file, and each one has already cost a debugging
// session in a real game:
//   * the container id is `fieldsId`, NOT `formId` — the engine resolves the
//     wrong key to null and the screen dies with a TypeError on first render;
//   * there is NO nickname field: identity comes from the lobby JWT;
//   * the model field must be named exactly `model` — the engine reads
//     `params.model` when it creates the participant, and any other name never
//     reaches it.
export default {
  elems: {
    authId: 'auth',
    fieldsId: 'auth-fields',
    errorId: 'auth-error',
    enterId: 'auth-enter',
    titleId: 'auth-title',
    informsId: 'auth-informs',
  },

  texts: {
    title: '{{GAME_TITLE}}',
    sections: [
      {
        heading: 'Controls',
        lines: [
          { keys: 'W, S', text: 'drive' },
          { keys: 'A, D', text: 'turn' },
          { keys: 'J', text: 'fire' },
          { separator: true },
          { keys: 'C', text: 'chat' },
          { keys: 'M', text: 'vote' },
          { keys: 'Tab', text: 'stats', last: true },
        ],
      },
    ],
  },

  params: [
    {
      name: 'model',
      value: 'a1',
      options: {
        control: 'select',
        label: 'Model',
        options: Object.keys(models),
        validator: 'isValidModel',
        storage: 'model',
      },
    },
  ],

  // validators are functions: they are not serialised to the client, they run
  // on the host when the answer comes back
  validators: {
    isValidModel: model => model in models,
  },
};
