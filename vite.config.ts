import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port: string = env.ORCHESTRATOR_PORT ?? '8787';
  return {
    server: {
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
      },
    },
  };
});
