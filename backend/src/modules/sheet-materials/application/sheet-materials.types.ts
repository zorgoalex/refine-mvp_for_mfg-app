import type { CurrentUser } from '../../../permissions/current-user';

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
  isActive: boolean;
  version: number;
}

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
  isActive?: boolean;
}

export interface SheetMaterialsContext {
  currentUser: CurrentUser;
  requestId: string;
}

export interface ListSheetMaterialTypesQuery extends SheetMaterialsContext {
  includeInactive?: boolean;
}

export interface GetSheetMaterialTypeQuery extends SheetMaterialsContext {
  id: number;
}

export interface CreateSheetMaterialTypeCommand extends SheetMaterialsContext {
  input: SheetMaterialTypeInput;
}

export interface UpdateSheetMaterialTypeCommand extends SheetMaterialsContext {
  id: number;
  expectedVersion: number;
  input: SheetMaterialTypeInput;
}

export interface DeactivateSheetMaterialTypeCommand extends SheetMaterialsContext {
  id: number;
  expectedVersion: number;
}

export interface SheetMaterialsPermissionDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: string[];
  requestId: string;
  targetId?: number;
}

export interface SheetMaterialsPort {
  list(query: ListSheetMaterialTypesQuery): Promise<SheetMaterialTypeDto[]>;
  getById(query: GetSheetMaterialTypeQuery): Promise<SheetMaterialTypeDto>;
  create(command: CreateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto>;
  update(command: UpdateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto>;
  deactivate(command: DeactivateSheetMaterialTypeCommand): Promise<void>;
  recordPermissionDenied(input: SheetMaterialsPermissionDeniedInput): Promise<void>;
}
