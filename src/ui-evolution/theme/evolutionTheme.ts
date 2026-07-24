import type { ThemeConfig } from 'antd';
import type { ThemeMode } from '../../theme/themeTypes';

const light = {
  canvas: '#F3F7F6',
  surface: '#FFFFFF',
  surfaceMuted: '#F8FBFA',
  text: '#17242A',
  textSecondary: '#61747A',
  border: '#DCE7E4',
  borderStrong: '#A9BBB6',
  primary: '#2764E7',
  primaryHover: '#1F56CB',
  primaryActive: '#1949AD',
  navigation: '#40C8B4',
  success: '#18875E',
  warning: '#A55C00',
  danger: '#C33B32',
};

const dark = {
  canvas: '#10191D',
  surface: '#17242A',
  surfaceMuted: '#1D2D33',
  text: '#EEF6F4',
  textSecondary: '#A8BBB7',
  border: '#31464B',
  borderStrong: '#4C666B',
  primary: '#6D99F5',
  primaryHover: '#86AAF7',
  primaryActive: '#557FD8',
  navigation: '#55D5C2',
  success: '#4DB58C',
  warning: '#E1A34D',
  danger: '#E2766E',
};

export function getEvolutionTheme(mode: ThemeMode): ThemeConfig {
  const colors = mode === 'dark' ? dark : light;

  return {
    token: {
      colorPrimary: colors.primary,
      colorPrimaryHover: colors.primaryHover,
      colorPrimaryActive: colors.primaryActive,
      colorInfo: colors.primary,
      colorSuccess: colors.success,
      colorWarning: colors.warning,
      colorError: colors.danger,
      colorBgBase: colors.surface,
      colorBgLayout: colors.canvas,
      colorBgContainer: colors.surface,
      colorBgElevated: colors.surface,
      colorFillAlter: colors.surfaceMuted,
      colorText: colors.text,
      colorTextSecondary: colors.textSecondary,
      colorBorder: colors.border,
      colorBorderSecondary: colors.border,
      colorSplit: colors.border,
      controlHeight: 40,
      controlHeightSM: 32,
      controlHeightLG: 44,
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      fontFamily: 'Inter, "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 14,
      boxShadow: '0 8px 28px rgba(24, 54, 61, 0.07)',
      boxShadowSecondary: '0 4px 16px rgba(24, 54, 61, 0.08)',
    },
    components: {
      Button: {
        controlHeight: 40,
        borderRadius: 8,
        primaryShadow: '0 4px 12px rgba(39, 100, 231, 0.16)',
        fontWeight: 650,
      },
      Input: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeShadow: '0 0 0 3px rgba(39, 100, 231, 0.16)',
      },
      Select: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeOutlineColor: 'rgba(39, 100, 231, 0.16)',
      },
      DatePicker: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeShadow: '0 0 0 3px rgba(39, 100, 231, 0.16)',
      },
      Table: {
        headerBg: colors.surfaceMuted,
        headerColor: colors.textSecondary,
        rowHoverBg: mode === 'dark' ? '#21383A' : '#E8F8F4',
        borderColor: colors.border,
        cellPaddingBlock: 12,
        cellPaddingInline: 12,
      },
      Tabs: {
        itemSelectedColor: colors.primary,
        itemHoverColor: colors.primaryHover,
        inkBarColor: colors.primary,
      },
      Card: {
        headerBg: colors.surface,
      },
      Menu: {
        darkItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
        darkItemColor: '#A9BEC2',
        darkItemHoverBg: '#214752',
        darkItemSelectedBg: '#25505A',
        darkItemSelectedColor: '#FFFFFF',
      },
    },
  };
}
