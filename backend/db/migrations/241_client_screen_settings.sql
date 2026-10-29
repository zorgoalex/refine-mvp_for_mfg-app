-- Экран клиента (план spec_erp/plans/2026-10-04-client-screen-plan.md §3.2): одна строка настроек на организацию.
-- enabled — общий выключатель показа; visible_codes — коды вкладок и полей заказа, которые видит клиент.
-- Хранится разрешённое: кода нет в списке — поле скрыто, поэтому поле, добавленное в реестр позже, скрыто у всех.
-- Только добавление: прежняя версия backend таблицу не читает.
BEGIN;

CREATE TABLE IF NOT EXISTS public.client_screen_settings (
  config_id SMALLINT PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT false,
  visible_codes TEXT[] NOT NULL DEFAULT '{}',
  version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id BIGINT NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_client_screen_settings_singleton CHECK (config_id = 1),
  CONSTRAINT chk_client_screen_settings_codes CHECK (array_position(visible_codes, NULL) IS NULL AND cardinality(visible_codes) <= 500),
  CONSTRAINT chk_client_screen_settings_version CHECK (version > 0)
);

-- Начальный набор — как в согласованном макете; показ выключен, пока его не включат в «Конфигурации».
INSERT INTO public.client_screen_settings (config_id, enabled, visible_codes) VALUES (1, false, ARRAY[
  'summary.number', 'summary.client', 'summary.parts', 'summary.area', 'summary.final',
  'tab.basic',
  'basic.client', 'basic.order_name', 'basic.order_date', 'basic.order_status', 'basic.manager', 'basic.doweling',
  'tab.details',
  'details.n', 'details.name', 'details.height', 'details.width', 'details.quantity', 'details.area',
  'details.material', 'details.milling_type', 'details.edge_type', 'details.film',
  'tab.dates',
  'dates.planned',
  'tab.finance',
  'finance.discount', 'finance.final', 'finance.paid', 'finance.debt', 'finance.payments',
  'tab.services',
  'services.name', 'services.quantity', 'services.price', 'services.sum'
]::text[])
ON CONFLICT (config_id) DO NOTHING;

COMMIT;
