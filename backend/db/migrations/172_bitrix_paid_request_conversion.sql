-- Additive, default-off automation. No existing request is converted by SQL.
ALTER TABLE public.bitrix24_incoming_request
  ADD COLUMN IF NOT EXISTS auto_conversion_status text NOT NULL DEFAULT 'idle'
    CHECK (auto_conversion_status IN ('idle','waiting','converted')),
  ADD COLUMN IF NOT EXISTS auto_conversion_reason text;

-- Positions/catalogue saves update their parent order. A paid waiting request
-- gets a targeted reconciliation, rather than waiting behind thousands of Deals.
CREATE OR REPLACE FUNCTION public.bitrix_paid_request_recheck() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_request record; installation_member text;
BEGIN
  IF NEW.order_kind <> 'crm_request' OR NEW.delete_flag THEN RETURN NEW; END IF;
  SELECT request_id,bitrix_deal_id INTO target_request FROM public.bitrix24_incoming_request
    WHERE linked_order_id=NEW.order_id AND state='active' AND auto_conversion_status='waiting';
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT member_id INTO installation_member FROM public.bitrix24_app_installation
    WHERE status='active' ORDER BY updated_at DESC LIMIT 1;
  IF installation_member IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.bitrix24_inbound_event(member_id,event_name,object_type,bitrix_id,event_ts,payload_json,fingerprint)
    VALUES (installation_member,'BITRIX24_RECONCILE_DEAL','deal',target_request.bitrix_deal_id,now(),'{}'::jsonb,
      'paid-request-edit:' || NEW.order_id || ':' || txid_current())
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS bitrix_paid_request_recheck ON public.orders;
CREATE TRIGGER bitrix_paid_request_recheck AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.bitrix_paid_request_recheck();
