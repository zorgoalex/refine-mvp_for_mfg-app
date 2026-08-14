BEGIN;

UPDATE cut_settings
SET value = jsonb_set(
  jsonb_set(
    value,
    '{defaultProfileId}',
    COALESCE(value->'defaultProfileId', '"mdf_board_preview"'::jsonb),
    true
  ),
  '{templates}',
  CASE
    WHEN jsonb_typeof(value->'templates') = 'array' AND jsonb_array_length(value->'templates') > 0
      THEN value->'templates'
    ELSE jsonb_build_array(jsonb_build_object(
      'id', 'mdf_board_preview',
      'name', 'MDF-превью',
      'active', true,
      'profile', COALESCE(value #> '{profiles,mdf_board_preview}', '{}'::jsonb)
    ))
  END,
  true
)
WHERE key = 'render.styles';

COMMIT;
