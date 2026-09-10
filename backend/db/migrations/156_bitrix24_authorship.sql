-- Display provenance only. Technical audit principals and financial hashes unchanged.
ALTER TABLE public.bitrix24_incoming_request_payment
  ADD COLUMN IF NOT EXISTS paid_by_id text,
  ADD COLUMN IF NOT EXISTS paid_by_name varchar(300);
ALTER TABLE public.bitrix24_manual_payment_command
  ADD COLUMN IF NOT EXISTS bitrix_actor_name varchar(300);
