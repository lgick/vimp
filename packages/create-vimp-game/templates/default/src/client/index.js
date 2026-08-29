import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import styles from './style.css?inline';
import parts from './parts/index.js';
import bakers from './bakers/index.js';
import { isNodeCore, loadNodeCore, loadWebCore } from '../host/nodeCore.js';

// ClientPlugin — the render half, main thread: PixiJS parts, procedural
// textures and the three hooks into the client core. Default export of the
// client entry (vite build --mode client); the engine loads it by
// GameManifest.entries.client.
export default {
  id: '{{GAME_ID}}',
  // same generation stamp as the host half and the manifest: imported, never
  // a literal, and not something the game ages out of (see src/host/index.js)
  engineApi: ENGINE_API_VERSION,

  // MUST return { core, memory }: `memory` is the WebAssembly memory the
  // engine reads the hot buffer out of every render tick. Without it the
  // client silently renders nothing but the discrete frames.
  async createClientCore(clientConfigJson, { wasmUrl } = {}) {
    if (isNodeCore(wasmUrl)) {
      const node = await loadNodeCore(wasmUrl);

      // the Node build exposes no WASM memory: the headless client reads the
      // hot buffer by copy (hot_values()) instead of through a view
      return { core: new node.ClientCore(clientConfigJson), memory: null };
    }

    const { default: init, ClientCore } = await loadWebCore();
    const wasm = await init({ module_or_path: wasmUrl });

    return { core: new ClientCore(clientConfigJson), memory: wasm.memory };
  },

  parts,
  bakers,

  // CSS as a string — see src/client/style.css
  styles,

  // all three hooks are called unconditionally: an empty body is fine, a
  // missing hook is a crash
  hooks: {
    // the model is known only after authorization, and the predictor cannot
    // move an actor whose speed and turn rate it does not know
    onAuth(core, authData) {
      core.set_model(authData.model);
    },

    // the authoritative panel: the local shot is gated by ammo, and this is
    // where the client core learns how much of it is left
    onPanel(core, panelData) {
      core.sync_panel(JSON.stringify(panelData));
    },

    // Local prediction of the shot: the tracer appears on the press instead
    // of a round trip later, and the core drops the authoritative twin of it
    // when the frame with it arrives. Returning null means "nothing to draw
    // locally" — every gate (alive, cooldown, ammo) lives in the core, which
    // mirrors the host: a guess the host would refuse is worse than no guess.
    onLocalAction(core, action, name, now) {
      if (action === 'down' && name === 'fire') {
        return core.try_fire(now) ?? null;
      }

      return null;
    },
  },
};
