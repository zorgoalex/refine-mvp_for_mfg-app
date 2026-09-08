/** Form state includes unset inputs and cleared nullable fields. */
export interface MovementStatusFormValues {
  movement_status_code?: string | null;
  movement_status_name?: string | null;
  sort_order?: number | null;
  is_active?: boolean;
  description?: string | null;
}
