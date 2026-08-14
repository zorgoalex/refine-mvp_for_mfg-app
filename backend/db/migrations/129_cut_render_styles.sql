BEGIN;

INSERT INTO cut_settings (key, value)
VALUES (
  'render.styles',
  '{
    "version": 1,
    "profiles": {
      "default": {
        "piece": {
          "defaultFill": "#eef3f8",
          "stroke": "#1f2d3d",
          "strokeWidthMm": 2,
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
          "fillStrategy": "fixed",
          "darkFill": "#1f2d3d",
          "lightFill": "#ffffff",
          "lightTextStroke": "#111827",
          "lightTextStrokeWidthRatio": 0
        },
        "sourceSvg": {
          "minStrokePx": null,
          "nonScalingStroke": false
        },
        "rawSvgScreenshot": {
          "minStrokePx": 2.4
        }
      },
      "mdf_board_preview": {
        "piece": {
          "defaultFill": "#eef3f8",
          "stroke": "#1f2d3d",
          "strokeWidthMm": 2,
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
          "lightFill": "#ffffff",
          "lightTextStroke": "#111827",
          "lightTextStrokeWidthRatio": 0.035
        },
        "sourceSvg": {
          "minStrokePx": 2.75,
          "nonScalingStroke": true
        },
        "rawSvgScreenshot": {
          "minStrokePx": 2.75
        }
      }
    }
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
