// src/pages/api/health/public.ts
// Public health endpoint for uptime monitoring (Pingdom, UptimeRobot, etc.)
// No auth required. For detailed service checks, see /api/health/ (admin-only)
import type { APIRoute } from 'astro';
import { successResponse } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async () => {
  return successResponse({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
};
