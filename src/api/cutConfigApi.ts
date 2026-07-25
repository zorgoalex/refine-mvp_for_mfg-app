import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export interface CutSettingRow {
  key: string;
  value: unknown;
  version: number;
}
export interface CutParamProfile {
  cutParamProfileId: number;
  name: string;
  params: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  version: number;
}
export interface CutRenderPreset {
  cutRenderPresetId: number;
  name: string;
  targetPx: number;
  background: string;
  isActive: boolean;
  version: number;
}
export interface CutPdfTemplate {
  cutPdfTemplateId: number;
  code: string;
  name: string;
  layout: Record<string, unknown>;
  isActive: boolean;
  version: number;
}
export interface CutPdfFieldCatalogItem {
  id: string;
  source: 'bazis' | 'dynamic' | 'detail' | 'order' | 'job' | 'group' | 'sheet' | 'cut' | 'custom';
  sourceColumn: string | null;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  category: string;
}
export interface CutConfig {
  settings: CutSettingRow[];
  paramProfiles: CutParamProfile[];
  renderPresets: CutRenderPreset[];
  pdfTemplates: CutPdfTemplate[];
}

export interface CutParamProfileInput {
  name: string;
  params: Record<string, unknown>;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface CutRenderPresetInput {
  name: string;
  targetPx: number;
  background?: string;
  isActive?: boolean;
}

export interface CutPdfTemplateInput {
  code?: string;
  name: string;
  layout: Record<string, unknown>;
  isActive?: boolean;
}

/**
 * Backend-owned cut-config admin client (CLAUDE.md principle 2/3): the
 * /configuration "Раскрой" tab reads + writes only through `/api/v1/cut-config`;
 * no page-level Hasura access. Writes carry the optimistic version.
 */
export const cutConfigApi = {
  get(): Promise<CutConfig> {
    return httpClient.get<CutConfig>(apiRoutes.cutConfig.root);
  },

  listPdfTemplateFields(): Promise<CutPdfFieldCatalogItem[]> {
    return httpClient.get<CutPdfFieldCatalogItem[]>(apiRoutes.cutConfig.pdfTemplateFields);
  },

  updateSetting(key: string, value: unknown, version: number): Promise<CutSettingRow> {
    return httpClient.put<CutSettingRow>(apiRoutes.cutConfig.setting(key), { value, version });
  },

  createParamProfile(input: CutParamProfileInput): Promise<CutParamProfile> {
    return httpClient.post<CutParamProfile>(apiRoutes.cutConfig.paramProfiles, input);
  },
  updateParamProfile(id: number, input: CutParamProfileInput, version: number): Promise<CutParamProfile> {
    return httpClient.put<CutParamProfile>(apiRoutes.cutConfig.paramProfile(id), { ...input, version });
  },
  deleteParamProfile(id: number, version: number): Promise<void> {
    return deleteWithVersion(apiRoutes.cutConfig.paramProfile(id), version);
  },

  createRenderPreset(input: CutRenderPresetInput): Promise<CutRenderPreset> {
    return httpClient.post<CutRenderPreset>(apiRoutes.cutConfig.renderPresets, input);
  },
  updateRenderPreset(id: number, input: CutRenderPresetInput, version: number): Promise<CutRenderPreset> {
    return httpClient.put<CutRenderPreset>(apiRoutes.cutConfig.renderPreset(id), { ...input, version });
  },
  deleteRenderPreset(id: number, version: number): Promise<void> {
    return deleteWithVersion(apiRoutes.cutConfig.renderPreset(id), version);
  },

  updatePdfTemplate(id: number, input: CutPdfTemplateInput, version: number): Promise<CutPdfTemplate> {
    return httpClient.put<CutPdfTemplate>(apiRoutes.cutConfig.pdfTemplate(id), { ...input, version });
  },
  createPdfTemplate(input: CutPdfTemplateInput & { code: string }): Promise<CutPdfTemplate> {
    return httpClient.post<CutPdfTemplate>(apiRoutes.cutConfig.pdfTemplates, input);
  },
};

function deleteWithVersion(path: string, version: number): Promise<void> {
  return httpClient.delete<void>(path, {
    body: JSON.stringify({ version }),
    headers: { 'Content-Type': 'application/json' },
  });
}
