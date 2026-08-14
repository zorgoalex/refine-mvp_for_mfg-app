import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { notifyOrderFormReferencesChanged } from './orderFormReferenceEvents';

export interface HdfProductionTechSettingsDto {
  minSideThresholdMm: number | null;
  minSideThresholdVersion: number | null;
  sheetMaterialTypeId: number | null;
  sheetMaterialName: string | null;
  sheetMaterialVersion: number | null;
  configRevision: number;
  extraResources: ExtraResourceDto[];
  millingTypes: HdfMillingSettingsDto[];
}

export interface HdfMillingSettingsDto {
  millingTypeId: number;
  name: string;
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
  hdfParameterName: string | null;
  extraResources: MillingExtraResourceDto[];
  version: number;
  isActive: boolean;
}

export interface MillingExtraResourceDto {
  id: number;
  millingTypeId: number;
  extraResourceId: number | null;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  parameterName: string;
  parameterMm: number | null;
  hdfAutoEnabled: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface ExtraResourceDto {
  id: number;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  defaultParameterName: string;
  defaultParameterMm: number | null;
  hdfAutoDefault: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface UpdateHdfProductionTechSettingsRequest {
  minSideThresholdMm?: number;
  minSideThresholdVersion?: number;
  sheetMaterialTypeId?: number | null;
  sheetMaterialVersion?: number;
}

export interface UpdateHdfMillingSettingsRequest {
  hdfEnabled?: boolean;
  hdfEdgeMm?: number | null;
  hdfParameterName?: string | null;
  extraResources?: UpdateMillingExtraResourceRequest[];
  expectedVersion: number;
}

export interface UpdateMillingExtraResourceRequest {
  id?: number;
  version?: number;
  extraResourceId?: number | null;
  resourceKind?: string;
  resourceRefType?: string | null;
  resourceRefId?: number | null;
  resourceName?: string;
  unitId?: number | null;
  accountingMethod?: string;
  parameterName?: string;
  parameterMm?: number | null;
  hdfAutoEnabled?: boolean;
  comment?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpsertExtraResourceRequest {
  version?: number;
  resourceKind: string;
  resourceRefType?: string | null;
  resourceRefId?: number | null;
  resourceName: string;
  unitId?: number | null;
  accountingMethod?: string;
  defaultParameterName?: string;
  defaultParameterMm?: number | null;
  hdfAutoDefault?: boolean;
  comment?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export const productionTechSettingsApi = {
  getHdf(): Promise<HdfProductionTechSettingsDto> {
    return httpClient.get<HdfProductionTechSettingsDto>(apiRoutes.productionTechSettings.hdf);
  },

  getExtraResources(): Promise<ExtraResourceDto[]> {
    return httpClient.get<ExtraResourceDto[]>(apiRoutes.productionTechSettings.extraResources);
  },

  async updateHdf(
    body: UpdateHdfProductionTechSettingsRequest,
    idempotencyKey = createProductionTechSettingsIdempotencyKey('hdf-settings'),
  ): Promise<HdfProductionTechSettingsDto> {
    assertIdempotencyKey(idempotencyKey);
    const response = await httpClient.put<HdfProductionTechSettingsDto>(
      apiRoutes.productionTechSettings.hdf,
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
    notifyOrderFormReferencesChanged('app_settings');
    return response;
  },

  async updateHdfMilling(
    millingTypeId: number,
    body: UpdateHdfMillingSettingsRequest,
    idempotencyKey = createProductionTechSettingsIdempotencyKey('hdf-milling'),
  ): Promise<{ success: true }> {
    if (!Number.isInteger(millingTypeId) || millingTypeId <= 0) throw new Error('Invalid millingTypeId');
    assertIdempotencyKey(idempotencyKey);
    const response = await httpClient.put<{ success: true }>(
      apiRoutes.productionTechSettings.hdfMillingType(millingTypeId),
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
    notifyOrderFormReferencesChanged('milling_types');
    return response;
  },

  async createExtraResource(
    body: UpsertExtraResourceRequest,
    idempotencyKey = createProductionTechSettingsIdempotencyKey('extra-resource-create'),
  ): Promise<ExtraResourceDto> {
    assertIdempotencyKey(idempotencyKey);
    const response = await httpClient.post<ExtraResourceDto>(
      apiRoutes.productionTechSettings.extraResources,
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
    notifyOrderFormReferencesChanged('milling_types');
    return response;
  },

  async updateExtraResource(
    extraResourceId: number,
    body: UpsertExtraResourceRequest,
    idempotencyKey = createProductionTechSettingsIdempotencyKey('extra-resource-update'),
  ): Promise<ExtraResourceDto> {
    if (!Number.isInteger(extraResourceId) || extraResourceId <= 0) throw new Error('Invalid extraResourceId');
    assertIdempotencyKey(idempotencyKey);
    const response = await httpClient.put<ExtraResourceDto>(
      apiRoutes.productionTechSettings.extraResource(extraResourceId),
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
    notifyOrderFormReferencesChanged('milling_types');
    return response;
  },
};

export function createProductionTechSettingsIdempotencyKey(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function assertIdempotencyKey(value: string): void {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 200) throw new Error('Invalid idempotencyKey');
}
