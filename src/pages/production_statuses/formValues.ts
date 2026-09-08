/** Form state includes unset inputs and cleared nullable fields. */
export interface ProductionStatusFormValues {
  production_status_code?: string | null;
  production_status_name?: string | null;
  sort_order?: number | null;
  color?: string | null;
  description?: string | null;
  is_active?: boolean;
  ref_key_1c?: string | null;
}
