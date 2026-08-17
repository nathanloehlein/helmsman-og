import type { Plugin, ViteDevServer } from 'vite';
import { buildDashboardResponse } from './server/dashboard-endpoint';

export function dashboardPlugin(): Plugin {
  return {
    name: 'backlog-runner-dashboard',
    configureServer(server: ViteDevServer): void {
      server.middlewares.use('/api/dashboard', (_req, res) => {
        buildDashboardResponse(process.env, new Date())
          .then((payload) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(payload));
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          });
      });
    },
  };
}
