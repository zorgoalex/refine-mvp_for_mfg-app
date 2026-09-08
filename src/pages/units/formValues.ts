/** Form state includes unset inputs and cleared nullable fields. */
export interface UnitFormValues {
  unit_code?: string | null;
  unit_name?: string | null;
  unit_symbol?: string | null;
  decimals?: number | null;
  ref_key_1c?: string | null;
  sort_order?: number | null;
}
