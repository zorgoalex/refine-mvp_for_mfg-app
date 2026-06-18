import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export interface CutSettingRow {
  key: string;
  value: unknown;
  version: number;
}
export interface SheetMaterialType {
  sheetMaterialTypeId: number;
  name: string;
  materialTypeId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  isActive: boolean;
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
export interface CutConfig {
  settings: CutSettingRow[];
  sheetMaterialTypes: SheetMaterialType[];
  paramProfiles: CutParamProfile[];
  renderPresets: CutRenderPreset[];
}

export interface SheetMaterialTypeInput {
  name: string;
  materialTypeId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  isActive?: boolean;
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

/**
 * Backend-owned cut-config admin client (CLAUDE.md principle 2/3): the
 * /configuration "Раскрой" tab reads + writes only through `/api/v1/cut-config`;
 * no page-level Hasura access. Writes carry the optimistic version.
 */
export const cutConfigApi = {
  get(): Promise<CutConfig> {
    return httpClient.get<CutConfig>(apiRoutes.cutConfig.root);
  },

  updateSetting(key: string, value: unknown, version: number): Promise<CutSettingRow> {
    return httpClient.put<CutSettingRow>(apiRoutes.cutConfig.setting(key), { value, version });
  },

  createSheetMaterialType(input: SheetMaterialTypeInput): Promise<SheetMaterialType> {
    return httpClient.post<SheetMaterialType>(apiRoutes.cutConfig.sheetMaterialTypes, input);
  },

  updateSheetMaterialType(id: number, input: SheetMaterialTypeInput, version: number): Promise<SheetMaterialType> {
    return httpClient.put<SheetMaterialType>(apiRoutes.cutConfig.sheetMaterialType(id), { ...input, version });
  },

  deleteSheetMaterialType(id: number, version: number): Promise<void> {
    return deleteWithVersion(apiRoutes.cutConfig.sheetMaterialType(id), version);
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
};

function deleteWithVersion(path: string, version: number): Promise<void> {
  return httpClient.delete<void>(path, {
    body: JSON.stringify({ version }),
    headers: { 'Content-Type': 'application/json' },
  });
}
