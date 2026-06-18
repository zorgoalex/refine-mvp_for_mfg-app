import type { CurrentUser } from '../../../permissions/current-user';

/** Read DTOs for the /configuration "Раскрой" tab (config-driven, plan §4a). */
export interface CutSettingRowDto {
  key: string;
  value: unknown;
  version: number;
}

export interface SheetMaterialTypeDto {
  sheetMaterialTypeId: number;
  name: string;
  materialTypeId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  isActive: boolean;
  version: number;
}

export interface CutParamProfileDto {
  cutParamProfileId: number;
  name: string;
  params: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  version: number;
}

export interface CutRenderPresetDto {
  cutRenderPresetId: number;
  name: string;
  targetPx: number;
  background: string;
  isActive: boolean;
  version: number;
}

export interface CutConfigDto {
  settings: CutSettingRowDto[];
  sheetMaterialTypes: SheetMaterialTypeDto[];
  paramProfiles: CutParamProfileDto[];
  renderPresets: CutRenderPresetDto[];
}

export interface CutConfigContext {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface UpdateCutSettingCommand extends CutConfigContext {
  key: string;
  value: unknown;
  expectedVersion: number;
}

export interface SheetMaterialTypeInput {
  name: string;
  materialTypeId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  isActive?: boolean;
}

export interface UpsertSheetMaterialTypeCommand extends CutConfigContext {
  sheetMaterialTypeId?: number;
  expectedVersion?: number;
  input: SheetMaterialTypeInput;
}

export interface DeleteCatalogRowCommand extends CutConfigContext {
  id: number;
  expectedVersion: number;
}

export interface CutParamProfileInput {
  name: string;
  params: Record<string, unknown>;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface UpsertCutParamProfileCommand extends CutConfigContext {
  cutParamProfileId?: number;
  expectedVersion?: number;
  input: CutParamProfileInput;
}

export interface CutRenderPresetInput {
  name: string;
  targetPx: number;
  background?: string;
  isActive?: boolean;
}

export interface UpsertCutRenderPresetCommand extends CutConfigContext {
  cutRenderPresetId?: number;
  expectedVersion?: number;
  input: CutRenderPresetInput;
}

export interface CutConfigPermissionDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: readonly string[];
  requestId?: string;
}

export interface CutConfigAdminPort {
  getConfig(context: CutConfigContext): Promise<CutConfigDto>;
  recordPermissionDenied(input: CutConfigPermissionDeniedInput): Promise<void>;
  updateSetting(command: UpdateCutSettingCommand): Promise<CutSettingRowDto>;
  upsertSheetMaterialType(command: UpsertSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto>;
  deleteSheetMaterialType(command: DeleteCatalogRowCommand): Promise<void>;
  upsertParamProfile(command: UpsertCutParamProfileCommand): Promise<CutParamProfileDto>;
  deleteParamProfile(command: DeleteCatalogRowCommand): Promise<void>;
  upsertRenderPreset(command: UpsertCutRenderPresetCommand): Promise<CutRenderPresetDto>;
  deleteRenderPreset(command: DeleteCatalogRowCommand): Promise<void>;
}
