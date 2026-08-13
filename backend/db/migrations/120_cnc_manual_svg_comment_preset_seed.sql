-- 120_cnc_manual_svg_comment_preset_seed.sql
-- Extra operator presets for manual SVG cut upload comments.

BEGIN;

INSERT INTO cnc_manual_svg_comment_presets (label, comment_text, category, sort_order)
VALUES
  ('Фрезы ХДФ', 'Фрезы для ХДФ: 8', 'tool', 60),
  ('Черновой с двух сторон', 'Черновой с двух сторон!!!', 'general', 70),
  ('Присадка №', 'Присадка №', 'general', 80),
  ('Фрезы 18мм', 'Фрезы для 18мм:', 'tool', 90),
  ('Черновой', 'Черновой', 'general', 100),
  ('Фрезы ЛДСП', 'Фрезы для ЛДСП: 8', 'tool', 110),
  ('Фрезы 10мм', 'Фрезы для 10мм:', 'tool', 120),
  ('Ламинированная сторона МДФ', 'Ламинированная сторона МДФ !!!', 'material', 130),
  ('Фреза ламинированной стороны', 'Фреза для ламинированной стороны:', 'tool', 140)
ON CONFLICT DO NOTHING;

COMMIT;
