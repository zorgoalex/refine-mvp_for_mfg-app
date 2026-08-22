import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { resolveDefaultNewOrderStatusId } from '../domain/orderStatusDefaults';

export interface ReferenceOption {
  label: string;
  value: number;
  sortOrder: number;
}

export interface SheetMaterialTypeOption extends ReferenceOption {
  widthMm: number | null;
  heightMm: number | null;
  isActive: boolean;
  isCuttable: boolean;
}

export interface OrderFormDataReferences {
  clients: ReferenceOption[];
  materials: ReferenceOption[];
  millingTypes: ReferenceOption[];
  edgeTypes: ReferenceOption[];
  films: ReferenceOption[];
  orderStatuses: ReferenceOption[];
  paymentStatuses: ReferenceOption[];
  paymentTypes: ReferenceOption[];
  productionStatuses: ReferenceOption[];
  workshops: ReferenceOption[];
  employees: ReferenceOption[];
  units: ReferenceOption[];
  sheetMaterialTypes: SheetMaterialTypeOption[];
  defaultOrderStatus: number | undefined;
  defaultPaymentStatus: number | undefined;
  defaultProductionStatus: number | undefined;
  materialNameById: Map<number, string>;
  millingTypeNameById: Map<number, string>;
  edgeTypeNameById: Map<number, string>;
  filmNameById: Map<number, string>;
  paymentTypeNameById: Map<number, string>;
  productionStatusNameById: Map<number, string>;
}

export const EMPTY_ORDER_FORM_DATA_REFERENCES = createEmptyReferences();

export function mapOrderFormDataToReferences(
  data: OrderFormDataResponse | null,
): OrderFormDataReferences {
  if (!data) return EMPTY_ORDER_FORM_DATA_REFERENCES;

  const clients = toOptions(data.clients, (item) => item.name);
  const materials = toOptions(data.materials, (item) => item.name);
  const millingTypes = toOptions(data.millingTypes, (item) => item.name);
  const edgeTypes = toOptions(data.edgeTypes, (item) => item.name);
  const films = toOptions(data.films, (item) => item.name);
  const orderStatuses = toOptions(data.orderStatuses, (item) => item.name);
  const paymentStatuses = toOptions(data.paymentStatuses, (item) => item.name);
  const paymentTypes = toOptions(data.paymentTypes, (item) => item.name);
  const productionStatuses = toOptions(data.productionStatuses, (item) => item.name);
  const workshops = toOptions(data.workshops, (item) => item.name);
  const employees = toOptions(data.employees, (item) => item.fullName);
  const units = toOptions(data.units, (item) => item.name);
  const sheetMaterialTypes: SheetMaterialTypeOption[] = data.sheetMaterialTypes
    ? data.sheetMaterialTypes.map((item) => ({
        label: item.name,
        value: item.id,
        widthMm: item.widthMm ?? null,
        heightMm: item.heightMm ?? null,
        isActive: item.isActive,
        isCuttable: item.isCuttable ?? true,
        sortOrder: item.sortOrder,
      }))
    : [];

  return {
    clients,
    materials,
    millingTypes,
    edgeTypes,
    films,
    orderStatuses,
    paymentStatuses,
    paymentTypes,
    productionStatuses,
    workshops,
    employees,
    units,
    sheetMaterialTypes,
    defaultOrderStatus: resolveDefaultNewOrderStatusId(orderStatuses),
    defaultPaymentStatus: paymentStatuses[0]?.value,
    defaultProductionStatus: productionStatuses[0]?.value,
    materialNameById: toNameMap(materials),
    millingTypeNameById: toNameMap(millingTypes),
    edgeTypeNameById: toNameMap(edgeTypes),
    filmNameById: toNameMap(films),
    paymentTypeNameById: toNameMap(paymentTypes),
    productionStatusNameById: toNameMap(productionStatuses),
  };
}

export function createBackendSelectProps(options: ReferenceOption[], isLoading = false) {
  return {
    options,
    loading: isLoading,
  };
}

function createEmptyReferences(): OrderFormDataReferences {
  return {
    clients: [],
    materials: [],
    millingTypes: [],
    edgeTypes: [],
    films: [],
    orderStatuses: [],
    paymentStatuses: [],
    paymentTypes: [],
    productionStatuses: [],
    workshops: [],
    employees: [],
    units: [],
    sheetMaterialTypes: [],
    defaultOrderStatus: undefined,
    defaultPaymentStatus: undefined,
    defaultProductionStatus: undefined,
    materialNameById: new Map(),
    millingTypeNameById: new Map(),
    edgeTypeNameById: new Map(),
    filmNameById: new Map(),
    paymentTypeNameById: new Map(),
    productionStatusNameById: new Map(),
  };
}

function toOptions<T extends { id: number; sortOrder?: number }>(
  items: T[],
  getLabel: (item: T) => string,
): ReferenceOption[] {
  return items.map((item) => ({
    label: getLabel(item),
    value: item.id,
    sortOrder: item.sortOrder ?? 0,
  }));
}

function toNameMap(options: ReferenceOption[]): Map<number, string> {
  return new Map(options.map((option) => [option.value, option.label]));
}
