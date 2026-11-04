-- Сигнал «у пользователя изменились уведомления» для потока колокольчика (план
-- plans/notification-engine/2026-10-27-notification-push-and-payment-events-plan.md, часть B, R3 APPROVED).
-- Появление и удаление уведомления (любого источника), отметка «прочитано» (в т. ч. в другой вкладке) и показ балуна
-- шлют pg_notify('erp_user_notifications', '<user_id>'). Содержимого в сигнале нет: вкладка по нему перечитывает список
-- и балуны через обычные эндпоинты с их правами. PostgreSQL сливает одинаковые сигналы одной транзакции и доставляет
-- их после COMMIT; откат сигналов не даёт. Слушает backend (флаг BACKEND_NOTIFICATION_STREAM_ENABLED); без слушателя
-- сигнал ничего не стоит.
-- Аренда балуна (balloon_lease_token / balloon_leased_at) сигнала НЕ даёт: иначе запрос балунов → сигнал → запрос
-- балунов по кругу.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.notification_user_signal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('erp_user_notifications', OLD.user_id::text);
  ELSE
    PERFORM pg_notify('erp_user_notifications', NEW.user_id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_notification_user_signal ON public.notifications;
DROP TRIGGER IF EXISTS trg_notification_user_signal_update ON public.notifications;
CREATE TRIGGER trg_notification_user_signal
  AFTER INSERT OR DELETE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.notification_user_signal();
CREATE TRIGGER trg_notification_user_signal_update
  AFTER UPDATE OF is_read, balloon_shown_at ON public.notifications
  FOR EACH ROW
  WHEN (OLD.is_read IS DISTINCT FROM NEW.is_read OR OLD.balloon_shown_at IS DISTINCT FROM NEW.balloon_shown_at)
  EXECUTE FUNCTION public.notification_user_signal();

COMMIT;
