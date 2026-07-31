import type { CurrentUser } from '../../../permissions/current-user';

export interface OrderResourceDemandQuery {
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sheetMaterialTypeId?: number;
  filmId?: number;
  supplierId?: number;
  vendorId?: number;
}

export interface OrderSheetMaterialDemandDto {
  sheetMaterialTypeId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  supplierId: number | null;
  supplierName: string | null;
}

export interface OrderFilmDemandDto {
  filmId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  linearMeters: number;
  sheets: number;
  hasCutData: boolean;
  vendorId: number | null;
  vendorName: string | null;
}

export interface OrderResourceDemandDto {
  orderId: number;
  orderName: string;
  fullNumber: string;
  orderDate: string | null;
  projectCode: string;
  clientName: string | null;
  updatedAt: string;
  sheetMaterials: OrderSheetMaterialDemandDto[];
  films: OrderFilmDemandDto[];
}

export interface OrderResourceDemandResponseDto {
  data: OrderResourceDemandDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  refreshedAt: string;
}

export interface ListOrderResourceDemandsCommand {
  currentUser: CurrentUser;
  query: OrderResourceDemandQuery;
}

export interface OrderResourceDemandRepositoryPort {
  list(command: ListOrderResourceDemandsCommand): Promise<OrderResourceDemandResponseDto>;
}
