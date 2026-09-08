/** Form state includes unset inputs and cleared nullable fields. */
export interface TransactionDirectionFormValues {
  direction_code?: string | null;
  direction_name?: string | null;
  description?: string | null;
  is_active?: boolean;
  sort_order?: number | null;
}
