BEGIN;

INSERT INTO public.roles (
  role_id,
  role_code,
  role_description,
  permissions,
  is_active,
  role_name
)
VALUES (
  30,
  'packer',
  'Упаковщик: просмотр заказов и установка статусов заказа "Готов к выдаче" / "Выдан"',
  '{}'::jsonb,
  true,
  'Упаковщик'
)
ON CONFLICT (role_id) DO UPDATE
SET
  role_code = EXCLUDED.role_code,
  role_description = EXCLUDED.role_description,
  permissions = EXCLUDED.permissions,
  is_active = true,
  role_name = EXCLUDED.role_name,
  updated_at = now();

COMMIT;
