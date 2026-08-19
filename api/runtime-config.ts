import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildFrontendRuntimeConfig, readBooleanEnv } from './_lib/frontend-runtime-config';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseConfig = buildFrontendRuntimeConfig();
  const config = {
    ...baseConfig,
    apiUrl: baseConfig.apiUrl || inferRuntimeApiUrl(req),
    features: {
      ...baseConfig.features,
      statusAutomation: readBooleanEnv(process.env.RUNTIME_CONFIG_STATUS_AUTOMATION, false),
    },
  };

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  return res.status(200).json(config);
}

function inferRuntimeApiUrl(req: VercelRequest): string {
  const rawHost = Array.isArray(req.headers?.host) ? req.headers.host[0] : req.headers?.host;
  const host = rawHost?.trim().toLowerCase().replace(/:\d+$/, '') ?? '';

  if (
    host === 'app-test.mebelkz.app' ||
    process.env.VERCEL_ENV === 'preview' ||
    process.env.VERCEL_GIT_COMMIT_REF === 'feat/backend-erp-stage1'
  ) {
    return 'https://backend-test.mebelkz.app';
  }

  return '';
}
