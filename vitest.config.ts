import { configDefaults, defineConfig } from 'vitest/config';
import { buildMeta } from './build-meta';

const meta = buildMeta();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(meta.version),
    __BUILD_DATE__: JSON.stringify(meta.date),
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '.agent-workspaces/**', '.helmsman-runs/**'],
  },
});
