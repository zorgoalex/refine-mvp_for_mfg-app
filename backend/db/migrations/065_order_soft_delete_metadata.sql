-- 065_order_soft_delete_metadata.sql
-- Метаданные мягкого удаления заказа для экрана «Корзина».
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by bigint NULL REFERENCES users(user_id);

COMMENT ON COLUMN orders.deleted_at IS 'Момент мягкого удаления (delete_flag=true); NULL у живых заказов';
COMMENT ON COLUMN orders.deleted_by IS 'user_id актора мягкого удаления; NULL у живых заказов';

CREATE INDEX IF NOT EXISTS idx_orders_deleted_at
  ON orders (deleted_at DESC)
  WHERE delete_flag = true;

-- Backfill best-effort из audit_log (последнее событие orders.delete на заказ).
UPDATE orders o
SET deleted_at = a.created_at,
    deleted_by = a.user_id
FROM (
  SELECT DISTINCT ON (related_order_id) related_order_id, created_at, user_id
  FROM audit_log
  WHERE event = 'orders.delete' AND related_order_id IS NOT NULL
  ORDER BY related_order_id, created_at DESC
) a
WHERE o.delete_flag = true
  AND o.deleted_at IS NULL
  AND a.related_order_id = o.order_id
  AND a.user_id IS NOT NULL;
