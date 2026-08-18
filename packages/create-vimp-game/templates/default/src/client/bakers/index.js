import actorTexture from './actorTexture.js';

// ClientPlugin.bakers: baker name -> function. The names are the ones
// parts.bakedAssets refers to (src/config/client.js); an entry naming a baker
// that is not here is skipped in silence, and the part gets an empty `assets`.
export default {
  actorTexture,
};
