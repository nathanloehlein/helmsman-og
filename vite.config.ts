import { defineConfig } from 'vite';
import { dashboardPlugin } from './vite-plugin-dashboard';

export default defineConfig({
  plugins: [dashboardPlugin()],
});
