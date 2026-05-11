export interface IdNameLookupDto {
  id: number;
  name: string;
}

export interface MaterialLookupDto extends IdNameLookupDto {
  unitId: number | null;
}

export interface MillingTypeLookupDto extends IdNameLookupDto {
  costPerSqm: number | null;
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
}
