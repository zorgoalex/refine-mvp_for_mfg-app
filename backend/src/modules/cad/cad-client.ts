import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import { cadCatalogSchema, cadFileSchema, cadJobSchema } from '../../shared/cad-api';

export class CadClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {}

  async request(path: string, options: RequestInit = {}) {
    if (!this.baseUrl || this.token.length < 32) throw new ApiError(503, 'CAD_NOT_CONFIGURED', 'CAD integration credential is missing');
    if (!/^\/api\/v2\/(integration\/(recipes|capabilities)|jobs(\/[a-z0-9]+(\/(package|status))?)?|artifacts\/[a-z0-9]+)$/.test(path)) {
      throw new ApiError(400, 'CAD_PATH_DENIED', 'Unsupported CAD endpoint');
    }
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError(503, 'CAD_URL_INVALID', 'Invalid CAD origin');
    url.pathname = path;
    const response = await this.transport(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${this.token}` } });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const parsed = z.object({ error: z.string() }).safeParse(body);
      throw new ApiError(response.status === 409 || response.status === 422 ? response.status : 502,
        parsed.success ? parsed.data.error : 'CAD_UPSTREAM_ERROR', 'CAD request failed');
    }
    return response;
  }

  async capabilities() {
    const body = await (await this.request('/api/v2/integration/capabilities')).json();
    const capabilities = z.object({ durable_jobs: z.literal(true), scoped_auth: z.literal(true), formats: z.array(z.string()) }).parse(body);
    if (!['svg', 'dxf'].every(format => capabilities.formats.includes(format))) throw new ApiError(503, 'CAD_FORMATS_UNAVAILABLE', 'CAD requires SVG and DXF exporters');
    return capabilities;
  }
  async catalog() { return cadCatalogSchema.parse(await (await this.request('/api/v2/integration/recipes')).json()); }
  async submit(payload: unknown, idempotencyKey: string) {
    return cadJobSchema.parse(await (await this.request('/api/v2/jobs', { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': idempotencyKey } })).json());
  }
  async job(id: string, summary = false) { return cadJobSchema.parse(await (await this.request(`/api/v2/jobs/${id}${summary ? '/status' : ''}`)).json()); }
  async package(id: string) { return cadFileSchema.parse(await (await this.request(`/api/v2/jobs/${id}/package`, { method: 'POST' })).json()); }
  async artifact(id: string) { return this.request(`/api/v2/artifacts/${id}`); }
}
