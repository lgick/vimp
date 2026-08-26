import a1 from './a1-package-fields.js';
import a2 from './a2-package-scripts.js';
import a3 from './a3-entry-paths.js';
import a4 from './a4-vite-config.js';
import a5 from './a5-cargo-core.js';
import a6 from './a6-manifest.js';
import a7 from './a7-package-repository.js';
import b1 from './b1-host-shape.js';
import b2 from './b2-engine-api.js';
import b3 from './b3-game-config-shape.js';
import b4 from './b4-teams.js';
import b5 from './b5-room-form.js';
import b6 from './b6-panel-reserved-key.js';
import b7 from './b7-chat-commands.js';
import b8 from './b8-system-messages.js';
import b9 from './b9-vote-names.js';
import b10 from './b10-respawns.js';
import c1 from './c1-client-shape.js';
import c2 from './c2-parts-registered.js';
import c3 from './c3-game-sets-coverage.js';
import c4 from './c4-component-dependencies.js';
import c5 from './c5-panel-time-field.js';
import c6 from './c6-stat-columns.js';
import c7 from './c7-key-sets.js';
import c8 from './c8-baked-assets.js';
import c9 from './c9-chat-messages.js';
import c10 from './c10-auth-schema.js';
import d1 from './d1-snapshot-ids.js';
import d2 from './d2-snapshot-classes.js';
import d3 from './d3-snapshot-interp.js';
import e1 from './e1-sound-pairs.js';
import e2 from './e2-map-images.js';
import e3 from './e3-sound-registry.js';

// Порядок групп — порядок отчёта: A пакет и сборка, B host, C client,
// D снапшот, E ассеты (plan/create-vimp-game/stage_1.md).
export const rules = [
  a1, a2, a3, a4, a5, a6, a7,
  b1, b2, b3, b4, b5, b6, b7, b8, b9, b10,
  c1, c2, c3, c4, c5, c6, c7, c8, c9, c10,
  d1, d2, d3,
  e1, e2, e3,
];

export default rules;
