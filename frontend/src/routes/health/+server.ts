import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  return json({
    status: 'ok',
    service: 'fr-frontend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
};
