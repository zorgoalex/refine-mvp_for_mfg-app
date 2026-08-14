BEGIN;

UPDATE cut_settings
SET value = jsonb_set(
  value,
  '{profiles}',
  COALESCE(value->'profiles', '{}'::jsonb) || jsonb_build_object(
    'mdf_board_preview',
    '{
      "piece": {
        "defaultFill": "#eef3f8",
        "stroke": "#1f2d3d",
        "strokeWidthMm": 1.6,
        "orderPalette": [
          "#d7e9ff",
          "#dff3d7",
          "#ffe6b8",
          "#f7d5e8",
          "#d9f0ef",
          "#eadcff",
          "#ffe0d2",
          "#e8edc9",
          "#d5e5f2",
          "#f2ddd5"
        ]
      },
      "label": {
        "fillStrategy": "contrast",
        "darkFill": "#111827",
        "darkTextStroke": "#ffffff",
        "darkTextStrokeWidthRatio": 0.08,
        "lightFill": "#ffffff",
        "lightTextStroke": "#111827",
        "lightTextStrokeWidthRatio": 0.08,
        "fontWeight": 800
      },
      "sourceSvg": {
        "minStrokePx": 1.6,
        "nonScalingStroke": true,
        "strokeColorMode": "piece-pastel",
        "fixedStroke": "#6ea7c8",
        "strokeOpacity": 0.72,
        "pastelSaturationPercent": 56,
        "pastelLightnessPercent": 56
      },
      "rawSvgScreenshot": {
        "minStrokePx": 2
      }
    }'::jsonb
  ),
  true
)
WHERE key = 'render.styles';

COMMIT;
