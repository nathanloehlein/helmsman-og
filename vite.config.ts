import { defineConfig, loadEnv } from 'vite';
import { dashboardPlugin } from './vite-plugin-dashboard';

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [dashboardPlugin()],
  };
});
