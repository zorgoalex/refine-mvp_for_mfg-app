/** Form state includes unset inputs and cleared nullable fields. */
export interface MaterialTransactionTypeFormValues {
  transaction_type_name?: string | null;
  direction_type_id?: number | null;
  affects_stock?: boolean;
  requires_document?: boolean;
  sort_order?: number | null;
  is_active?: boolean;
  description?: string | null;
}
