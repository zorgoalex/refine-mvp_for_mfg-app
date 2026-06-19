import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

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
  version: number;
}

export const sheetMaterialsApi = {
  create(input: SheetMaterialTypeInput): Promise<SheetMaterialTypeDto> {
    return httpClient.post<SheetMaterialTypeDto>(apiRoutes.sheetMaterials.list, input);
  },

  update(id: number, input: SheetMaterialTypeInput, version: number): Promise<SheetMaterialTypeDto> {
    return httpClient.put<SheetMaterialTypeDto>(apiRoutes.sheetMaterials.byId(id), { ...input, version });
  },

  deactivate(id: number, version: number): Promise<void> {
    return httpClient.delete<void>(apiRoutes.sheetMaterials.byId(id), {
      body: JSON.stringify({ version }),
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
