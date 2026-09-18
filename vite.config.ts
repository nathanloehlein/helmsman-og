import { defineConfig, loadEnv } from 'vite';
import { buildMeta } from './build-meta';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port: string = env.HELMSMAN_PORT ?? '8787';
  const meta = buildMeta();
  return {
    define: {
      __APP_VERSION__: JSON.stringify(meta.version),
      __BUILD_DATE__: JSON.stringify(meta.date),
    },
    server: {
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
      },
    },
  };
});
