/** Переменные стиля экрана снабжения (мокап) из токенов темы antd — чистая функция для тестов. */
export interface RrThemeTokens {
  colorBgLayout: string;
  colorBgContainer: string;
  colorFillAlter: string;
  colorText: string;
  colorTextSecondary: string;
  colorBorder: string;
  colorPrimary: string;
  colorPrimaryHover: string;
  colorPrimaryBg: string;
  colorSuccess: string;
  colorSuccessBg: string;
  colorWarning: string;
  colorWarningBg: string;
  colorError: string;
  colorErrorBg: string;
  colorFillSecondary: string;
  colorBgSpotlight: string;
  boxShadowTertiary?: string;
}

/** Светлая тема — по яркости фона карточек. */
export function isLightSurface(color: string): boolean {
  const hex = color.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return !/^rgba?\(\s*(\d+)/.test(color) || Number(/^rgba?\(\s*(\d+)/.exec(color)![1]) > 127;
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

export function rrThemeVars(token: RrThemeTokens): Record<string, string> {
  const light = isLightSurface(token.colorBgContainer);
  return {
    '--rr-bg': token.colorBgLayout,
    '--rr-surface': token.colorBgContainer,
    '--rr-surface-2': token.colorFillAlter,
    '--rr-text': token.colorText,
    '--rr-muted': token.colorTextSecondary,
    '--rr-border': token.colorBorder,
    '--rr-border-strong': token.colorBorder,
    '--rr-accent': token.colorPrimary,
    '--rr-accent-hover': token.colorPrimaryHover,
    '--rr-accent-soft': token.colorPrimaryBg,
    '--rr-ok': token.colorSuccess,
    '--rr-ok-soft': token.colorSuccessBg,
    '--rr-warn': token.colorWarning,
    '--rr-warn-soft': token.colorWarningBg,
    '--rr-bad': token.colorError,
    '--rr-bad-soft': token.colorErrorBg,
    '--rr-none-soft': token.colorFillSecondary,
    '--rr-ordered': '#7c8cf8',
    '--rr-row-hover': light ? '#f5f9ff' : 'rgba(255, 255, 255, .04)',
    // Строка-заголовок группы — лёгкий голубой, чтобы выделялась среди позиций.
    '--rr-grp-bg': light ? '#e6f4ff' : 'rgba(64, 150, 255, .18)',
    // Выбранный приход в списке — контрастнее обычного выделения строки.
    '--rr-row-picked': light ? '#bae0ff' : 'rgba(64, 150, 255, .34)',
    '--rr-row-selected': light ? '#eef5ff' : 'rgba(64, 150, 255, .12)',
    // Тёмная панель действий как в мокапе; в тёмной теме — «прожекторный» фон темы.
    '--rr-sticky-bg': light ? '#1d2330' : token.colorBgSpotlight,
    '--rr-shadow': light ? '0 1px 2px rgba(16,24,40,.06), 0 4px 16px rgba(16,24,40,.06)' : 'none',
  };
}
