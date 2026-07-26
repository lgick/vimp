import { defineConfig } from 'vite';
import pugPlugin from 'vite-plugin-pug';
import fs from 'fs';
import path from 'path';
import masterConfig from './src/config/master.js';

const isDev = process.env.NODE_ENV === 'development';
let httpsConfig = false;

if (isDev) {
  const keyPath = masterConfig.httpsOptions.key;
  const certPath = masterConfig.httpsOptions.cert;

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error(`
      [Vite HMR Error] Certificate files not found!
      Please ensure these files exist:
      - Key: ${path.resolve(keyPath)}
      - Cert: ${path.resolve(certPath)}
    `);
    process.exit(1);
  }

  httpsConfig = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

export default defineConfig({
  plugins: [pugPlugin()],
  server: {
    https: httpsConfig,
    hmr: isDev ? { protocol: 'wss', port: 3001 } : false,
    fs: {
      // корень репозитория: Vite dev (root — packages/engine) должен читать
      // workspace-симлинки node_modules/@vimp/*, файлы games/ и games/*/core/pkg-web
      allow: [path.resolve(import.meta.dirname, '..', '..')],
    },
  },
});
