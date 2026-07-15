-- 067_order_area_geometry_backfill.sql
-- Приводит сохранённые площади существующих заказов к геометрической формуле.

UPDATE order_details od
SET area = ROUND(
  (od.height::numeric * od.width::numeric * od.quantity::numeric) / 1000000,
  2
)
WHERE od.area IS DISTINCT FROM ROUND(
  (od.height::numeric * od.width::numeric * od.quantity::numeric) / 1000000,
  2
);

UPDATE orders o
SET total_area = geometry.total_area
FROM (
  SELECT
    source.order_id,
    ROUND(COALESCE(SUM(source.area_mm2), 0) / 1000000, 2) AS total_area
  FROM (
    SELECT o2.order_id, od.height::numeric * od.width::numeric * od.quantity::numeric AS area_mm2
    FROM orders o2
    LEFT JOIN order_details od
      ON od.order_id = o2.order_id
     AND od.delete_flag = false
  ) source
  GROUP BY source.order_id
) geometry
WHERE geometry.order_id = o.order_id
  AND o.total_area IS DISTINCT FROM geometry.total_area;
