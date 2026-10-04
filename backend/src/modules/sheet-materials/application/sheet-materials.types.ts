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
  refKey1c: string | null;
  isActive: boolean;
  isCuttable: boolean;
  sortOrder: number;
  /** Тип и категория номенклатуры 1С, примечание (как у плёнок). */
  nomenclatureType: string | null;
  nomenclatureCategory: string | null;
  note: string | null;
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
  refKey1c?: string | null;
  isActive?: boolean;
  isCuttable?: boolean;
  sortOrder?: number;
  /** Не передано — при изменении значение сохраняется (старые клиенты PUT без этих полей); null или '' — очистить. */
  nomenclatureType?: string | null;
  nomenclatureCategory?: string | null;
  note?: string | null;
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

/** Позиция номенклатуры 1С для выбора в форме листового материала. */
export interface OnecItemOptionDto {
  refKey: string;
  code: string | null;
  name: string;
  unitName: string | null;
  categoryName: string | null;
  nomenclatureType: string | null;
  deletionMark: boolean;
  /** Листовой материал ERP, уже привязанный к этой позиции (любой, включая отключённые). */
  linkedSheetMaterialTypeId: number | null;
  linkedName: string | null;
}

/** Позиции 1С из копии данных; `null` — копия недоступна (модуль 1С выключен, данных нет): ключ вводится вручную. */
export type OnecItemsSource = () => Promise<Array<Omit<OnecItemOptionDto, 'linkedSheetMaterialTypeId' | 'linkedName'>> | null>;

export interface SheetMaterialsPort {
  list(query: ListSheetMaterialTypesQuery): Promise<SheetMaterialTypeDto[]>;
  getById(query: GetSheetMaterialTypeQuery): Promise<SheetMaterialTypeDto>;
  create(command: CreateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto>;
  update(command: UpdateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto>;
  deactivate(command: DeactivateSheetMaterialTypeCommand): Promise<void>;
  recordPermissionDenied(input: SheetMaterialsPermissionDeniedInput): Promise<void>;
}
