/** Business names are Unicode text, not ASCII identifiers or numbers. */
export const NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function humanNameError(value: string, max: number, min = 1): string | null {
  if (NAME_CONTROL_CHARACTERS.test(value)) return 'Название не должно содержать управляющие символы';
  const name = value.trim();
  if (name.length < min) return `Введите название: минимум ${min} симв.`;
  if (name.length > max) return `Название: максимум ${max} симв.`;
  return null;
}

export const REFERENCE_NAME_LIMITS: Record<string, readonly [number, number]> = {
  client_name: [2, Number.MAX_SAFE_INTEGER], full_name: [1, 200], username: [3, 100],
  vendor_name: [1, 250], supplier_name: [1, 250], film_vendor_name: [1, 250],
  film_name: [1, 200], material_name: [1, 200], material_type_name: [1, 64],
  milling_type_name: [1, 100], film_type_name: [1, 50], edge_type_name: [1, 50],
  type_paid_name: [1, 50], payment_status_name: [1, 50], production_status_name: [1, 50],
  order_status_name: [1, 50], transaction_type_name: [1, 50], movement_status_name: [1, 50],
  requisition_status_name: [1, 50], requirement_status_name: [1, 50],
  workshop_name: [1, 128], workcenter_name: [1, 128], warehouse_name: [1, 128],
  direction_name: [1, 128], unit_name: [1, Number.MAX_SAFE_INTEGER], order_name: [1, 200], detail_name: [0, 200],
};
