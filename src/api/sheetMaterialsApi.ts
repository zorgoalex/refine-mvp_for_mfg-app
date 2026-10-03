import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { notifyOrderFormReferencesChanged } from './orderFormReferenceEvents';

export interface SheetMaterialTypeInput {
  name: string;
  materialTypeId: number;
  unitId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  supplierId?: number | null;
  vendorId?: number | null;
  supplierArticle?: string | null;
  texture?: boolean | null;
  color?: string | null;
  refKey1c?: string | null;
  isActive?: boolean;
  isCuttable?: boolean;
  sortOrder?: number;
  nomenclatureType?: string | null;
  nomenclatureCategory?: string | null;
  note?: string | null;
}

export interface SheetMaterialTypeDto {
  sheetMaterialTypeId: number;
  name: string;
  materialTypeId: number;
  unitId: number;
  thicknessMm: number;
  widthMm: number;
  heightMm: number;
  supplierId: number | null;
  vendorId: number | null;
  supplierArticle: string | null;
  texture: boolean | null;
  color: string | null;
  refKey1c: string | null;
  isActive: boolean;
  isCuttable: boolean;
  sortOrder: number;
  /** Нет у backend до миграции 234. */
  nomenclatureType?: string | null;
  nomenclatureCategory?: string | null;
  note?: string | null;
  version: number;
}

export const sheetMaterialsApi = {
  list(includeInactive = false): Promise<SheetMaterialTypeDto[]> {
    return httpClient.get<SheetMaterialTypeDto[]>(
      includeInactive ? `${apiRoutes.sheetMaterials.list}?includeInactive=true` : apiRoutes.sheetMaterials.list,
    );
  },

  /** Возможности backend; прежний backend отвечает ошибкой («capabilities» как id) — поля считаются неподдержанными. */
  capabilities(): Promise<{ nomenclatureFields?: boolean }> {
    return httpClient.get<{ nomenclatureFields?: boolean }>(apiRoutes.sheetMaterials.capabilities);
  },

  get(id: number): Promise<SheetMaterialTypeDto> {
    return httpClient.get<SheetMaterialTypeDto>(apiRoutes.sheetMaterials.byId(id));
  },

  async create(input: SheetMaterialTypeInput): Promise<SheetMaterialTypeDto> {
    const response = await httpClient.post<SheetMaterialTypeDto>(
      apiRoutes.sheetMaterials.list,
      input,
    );
    notifyOrderFormReferencesChanged('sheet_material_types');
    return response;
  },

  async update(
    id: number,
    input: SheetMaterialTypeInput,
    version: number,
  ): Promise<SheetMaterialTypeDto> {
    const response = await httpClient.put<SheetMaterialTypeDto>(
      apiRoutes.sheetMaterials.byId(id),
      { ...input, version },
    );
    notifyOrderFormReferencesChanged('sheet_material_types');
    return response;
  },

  async deactivate(id: number, version: number): Promise<void> {
    await httpClient.delete<void>(apiRoutes.sheetMaterials.byId(id), {
      body: JSON.stringify({ version }),
      headers: { 'Content-Type': 'application/json' },
    });
    notifyOrderFormReferencesChanged('sheet_material_types');
  },
};
