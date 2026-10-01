import type { FastifyInstance } from 'fastify';
import { getAnalytics, getDashboard, getStorageOverview } from '../services/dashboard';
import { getSystemHealth } from '../services/system';

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', { preHandler: app.authenticate }, async () => getDashboard());
  app.get('/analytics', { preHandler: app.requirePermission('activity.view') }, async (req) => getAnalytics(req.query));
  app.get('/storage', { preHandler: app.requirePermission('system.view') }, async () => getStorageOverview());
  app.get('/system', { preHandler: app.requirePermission('system.view') }, async () => getSystemHealth());
}
