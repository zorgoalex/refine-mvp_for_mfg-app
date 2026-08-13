export interface IdNameLookupDto {
  id: number;
  name: string;
  sortOrder: number;
}

export interface MaterialLookupDto extends IdNameLookupDto {
  unitId: number | null;
}

export interface MillingTypeLookupDto extends IdNameLookupDto {
  costPerSqm: number | null;
  hdfEnabled?: boolean;
  hdfEdgeMm?: number | null;
  version?: number;
}

// SP3: sheet-material picker option. Carries dimensions for the FE dimension
// mirror and is_active so the picker can disable (not drop) a deactivated
// currently-selected sheet type. Only attached when the caller has
// sheet_materials.view (masked at the service layer).
// Variant B: isCuttable=false marks header-only materials (e.g. «краска») that
// must not appear in the DETAIL picker (only the HEADER picker may carry them).
export interface SheetMaterialTypeLookupDto extends IdNameLookupDto {
  widthMm: number | null;
  heightMm: number | null;
  isActive: boolean;
  isCuttable: boolean;
}

export interface StatusLookupDto extends IdNameLookupDto {
  code?: string | null;
  color?: string | null;
}

export interface EmployeeLookupDto {
  id: number;
  fullName: string;
}

export interface UnitLookupDto {
  id: number;
  code: string;
  name: string;
  symbol?: string;
  sortOrder: number;
}

export interface OrderFormDataResponseDto {
  clients: IdNameLookupDto[];
  materials: MaterialLookupDto[];
  millingTypes: MillingTypeLookupDto[];
  edgeTypes: IdNameLookupDto[];
  films: IdNameLookupDto[];
  orderStatuses: StatusLookupDto[];
  paymentStatuses: StatusLookupDto[];
  paymentTypes: IdNameLookupDto[];
  productionStatuses: StatusLookupDto[];
  workshops: IdNameLookupDto[];
  employees: EmployeeLookupDto[];
  units: UnitLookupDto[];
  // SP3: present ONLY when the caller has sheet_materials.view (service-masked).
  sheetMaterialTypes?: SheetMaterialTypeLookupDto[];
}
