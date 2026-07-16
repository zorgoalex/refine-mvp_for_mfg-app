-- Per-user размер интерфейса (antd componentSize): NULL/`default` = стандарт,
-- `small` = компактный. Нормализация значений — в коде backend.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ui_size TEXT;
