import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildFrontendRuntimeConfig } from './_lib/frontend-runtime-config';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const config = buildFrontendRuntimeConfig();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  return res.status(200).json(config);
}
