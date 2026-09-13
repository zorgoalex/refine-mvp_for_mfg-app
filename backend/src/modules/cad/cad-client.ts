import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import { cadCatalogSchema, cadFileSchema, cadFilePageSchema, cadJobSchema, cadPreviewSchema, cadEvaluationSchema, cadReadinessSchema, cadReadinessItemSchema, cadApprovalReceiptSchema } from '../../shared/cad-api';
import type { CadRecipeRef } from '../../shared/cad-workspace';

export class CadClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {}

  async request(path: string, options: RequestInit = {}) {
    if (!this.baseUrl || this.token.length < 32) throw new ApiError(503, 'CAD_NOT_CONFIGURED', 'CAD integration credential is missing');
    if (!/^\/api\/v2\/(integration\/(recipes|capabilities|evaluate-recipes|preview)|jobs(\/[a-z0-9]+(\/(package|status|readiness(?:\/(?:issues\/\d+|parts\/[A-Za-z0-9_-]+))?|approve-exception|files\/\d+|artifacts\/[a-z0-9]+|exceptions\/[a-z0-9-]+))?)?|artifacts\/[a-z0-9]+)$/.test(path)) {
      throw new ApiError(400, 'CAD_PATH_DENIED', 'Unsupported CAD endpoint');
    }
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError(503, 'CAD_URL_INVALID', 'Invalid CAD origin');
    url.pathname = path;
    const response = await this.transport(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(path.endsWith('/package') ? 120000 : 30000),
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
    const capabilities = z.object({ durable_jobs: z.literal(true), scoped_auth: z.literal(true), formats: z.array(z.string()),
      editor_version: z.number().optional(), parameter_policies: z.boolean().optional(), part_previews: z.boolean().optional(), scoped_exceptions: z.boolean().optional(),
      max_parts: z.number().optional(), bounded_runs: z.boolean().optional(), file_pages: z.boolean().optional(), readiness_pages: z.boolean().optional() }).parse(body);
    if (!['svg', 'dxf'].every(format => capabilities.formats.includes(format))) throw new ApiError(503, 'CAD_FORMATS_UNAVAILABLE', 'CAD requires SVG and DXF exporters');
    return capabilities;
  }
  async catalog() { return cadCatalogSchema.parse(await (await this.request('/api/v2/integration/recipes')).json()); }
  async submit(payload: unknown, idempotencyKey: string) {
    return cadJobSchema.parse(await (await this.request('/api/v2/jobs', { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': idempotencyKey } })).json());
  }
  async job(id: string, summary = false) { return cadJobSchema.parse(await (await this.request(`/api/v2/jobs/${id}${summary ? '/status' : ''}`)).json()); }
  async package(id: string) { return cadFileSchema.parse(await (await this.request(`/api/v2/jobs/${id}/package`, { method: 'POST' })).json()); }
  async files(id: string, offset: number) { return cadFilePageSchema.parse(await (await this.request(`/api/v2/jobs/${id}/files/${offset}`)).json()); }
  async jobArtifact(id: string, artifactId: string) { return cadFileSchema.parse(await (await this.request(`/api/v2/jobs/${id}/artifacts/${artifactId}`)).json()); }
  async artifact(id: string) { return this.request(`/api/v2/artifacts/${id}`); }
  async preview(payload: unknown) {
    return cadPreviewSchema.parse(await (await this.request('/api/v2/integration/preview', { method: 'POST', body: JSON.stringify(payload) })).json());
  }
  async evaluate(recipes: CadRecipeRef[]) {
    const items: z.infer<typeof cadEvaluationSchema>['items'] = [];
    for (let start = 0; start < recipes.length; start += 500) {
      const batch = recipes.slice(start, start + 500);
      const result = cadEvaluationSchema.parse(await (await this.request('/api/v2/integration/evaluate-recipes', { method: 'POST', body: JSON.stringify({ recipes: batch }) })).json()).items;
      if (result.length !== batch.length) throw new ApiError(502, 'CAD_EVALUATION_INCOMPLETE', 'Incomplete policy evaluation');
      items.push(...result);
    }
    return items;
  }
  async readiness(id: string, offset = 0) { return cadReadinessSchema.parse(await (await this.request(`/api/v2/jobs/${id}/readiness/issues/${offset}`)).json()); }
  async readinessPart(id: string, partId: string) { return cadReadinessItemSchema.parse(await (await this.request(`/api/v2/jobs/${id}/readiness/parts/${partId}`)).json()); }
  async exceptionReceipt(id: string, key: string) {
    return z.object({ receipt: cadApprovalReceiptSchema.nullable() }).parse(
      await (await this.request(`/api/v2/jobs/${id}/exceptions/${key}`)).json()).receipt;
  }
  async approveException(id: string, key: string, payload: { part_id: string; actor: { id: number; name: string }; reason: string }) {
    return cadApprovalReceiptSchema.parse(await (await this.request(`/api/v2/jobs/${id}/approve-exception`,
      { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) })).json());
  }
}
