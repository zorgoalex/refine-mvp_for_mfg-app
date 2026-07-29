import type { ThemeConfig } from 'antd';
import type { ThemeMode } from '../../theme/themeTypes';
import type { ModernUiVariant } from '../../ui-variant/uiVariant';

interface ModernUiPalette {
  canvas: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textSecondary: string;
  border: string;
  borderStrong: string;
  primary: string;
  primaryHover: string;
  primaryActive: string;
  primaryShadow: string;
  focusShadow: string;
  navigation: string;
  success: string;
  warning: string;
  danger: string;
  rowHoverBg: string;
  radiusSm: number;
  radiusMd: number;
  radiusLg: number;
  shadow: string;
  shadowSecondary: string;
  menuItemColor: string;
  menuHoverBg: string;
  menuHoverColor: string;
  menuSelectedBg: string;
  menuSelectedColor: string;
}

const palettes: Record<ModernUiVariant, Record<ThemeMode, ModernUiPalette>> = {
  evolution: {
    light: {
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
      primaryShadow: '0 4px 12px rgba(39, 100, 231, 0.16)',
      focusShadow: '0 0 0 3px rgba(39, 100, 231, 0.16)',
      navigation: '#40C8B4',
      success: '#18875E',
      warning: '#A55C00',
      danger: '#C33B32',
      rowHoverBg: '#E8F8F4',
      radiusSm: 6,
      radiusMd: 8,
      radiusLg: 12,
      shadow: '0 8px 28px rgba(24, 54, 61, 0.07)',
      shadowSecondary: '0 4px 16px rgba(24, 54, 61, 0.08)',
      menuItemColor: '#A9BEC2',
      menuHoverBg: '#214752',
      menuHoverColor: '#FFFFFF',
      menuSelectedBg: '#25505A',
      menuSelectedColor: '#FFFFFF',
    },
    dark: {
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
      primaryShadow: '0 4px 12px rgba(109, 153, 245, 0.22)',
      focusShadow: '0 0 0 3px rgba(109, 153, 245, 0.22)',
      navigation: '#55D5C2',
      success: '#4DB58C',
      warning: '#E1A34D',
      danger: '#E2766E',
      rowHoverBg: '#21383A',
      radiusSm: 6,
      radiusMd: 8,
      radiusLg: 12,
      shadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
      shadowSecondary: '0 4px 16px rgba(0, 0, 0, 0.26)',
      menuItemColor: '#A9BEC2',
      menuHoverBg: '#173D47',
      menuHoverColor: '#FFFFFF',
      menuSelectedBg: '#1D4B55',
      menuSelectedColor: '#FFFFFF',
    },
  },
  line: {
    light: {
      canvas: '#F2F5F5',
      surface: '#FFFFFF',
      surfaceMuted: '#F6F8F8',
      text: '#172526',
      textSecondary: '#4F6262',
      border: '#DDE5E4',
      borderStrong: '#B9C8C6',
      primary: '#246B62',
      primaryHover: '#1A564F',
      primaryActive: '#143F3A',
      primaryShadow: '0 3px 10px rgba(36, 107, 98, 0.18)',
      focusShadow: '0 0 0 3px rgba(36, 107, 98, 0.16)',
      navigation: '#6FD1C4',
      success: '#2C7A52',
      warning: '#9A5B00',
      danger: '#B5352D',
      rowHoverBg: '#F4F9F8',
      radiusSm: 9,
      radiusMd: 10,
      radiusLg: 14,
      shadow: '0 1px 2px rgba(23, 37, 38, 0.04)',
      shadowSecondary: '0 1px 2px rgba(23, 37, 38, 0.05)',
      menuItemColor: '#D8E7E4',
      menuHoverBg: '#1E4A45',
      menuHoverColor: '#FFFFFF',
      menuSelectedBg: '#F4FAF8',
      menuSelectedColor: '#16433E',
    },
    dark: {
      canvas: '#0F1818',
      surface: '#172322',
      surfaceMuted: '#1F2F2D',
      text: '#EEF6F4',
      textSecondary: '#B4C7C3',
      border: '#314642',
      borderStrong: '#58736E',
      primary: '#73D8CB',
      primaryHover: '#8FE4DA',
      primaryActive: '#56BDB1',
      primaryShadow: '0 4px 14px rgba(115, 216, 203, 0.18)',
      focusShadow: '0 0 0 3px rgba(115, 216, 203, 0.18)',
      navigation: '#6FD1C4',
      success: '#5FBD88',
      warning: '#D9A152',
      danger: '#DC746D',
      rowHoverBg: '#203835',
      radiusSm: 9,
      radiusMd: 10,
      radiusLg: 14,
      shadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
      shadowSecondary: '0 4px 16px rgba(0, 0, 0, 0.26)',
      menuItemColor: '#C6DBD7',
      menuHoverBg: '#123A35',
      menuHoverColor: '#FFFFFF',
      menuSelectedBg: '#E8F7F4',
      menuSelectedColor: '#103934',
    },
  },
  air: {
    light: {
      canvas: '#FFF8F2',
      surface: '#FFFFFF',
      surfaceMuted: '#FFF4EA',
      text: '#202640',
      textSecondary: '#5B6079',
      border: '#E8E4E8',
      borderStrong: '#C8C4D0',
      primary: '#315BEA',
      primaryHover: '#2448C7',
      primaryActive: '#1C3AA6',
      primaryShadow: '0 10px 24px rgba(49, 91, 234, 0.22)',
      focusShadow: '0 0 0 3px rgba(49, 91, 234, 0.18)',
      navigation: '#FF725E',
      success: '#23855B',
      warning: '#B35A16',
      danger: '#C73F4A',
      rowHoverBg: '#F4F6FF',
      radiusSm: 12,
      radiusMd: 16,
      radiusLg: 22,
      shadow: '0 18px 44px rgba(38, 47, 92, 0.10)',
      shadowSecondary: '0 10px 24px rgba(38, 47, 92, 0.08)',
      menuItemColor: '#5B6079',
      menuHoverBg: '#F1F4FF',
      menuHoverColor: '#202640',
      menuSelectedBg: '#315BEA',
      menuSelectedColor: '#FFFFFF',
    },
    dark: {
      canvas: '#11131F',
      surface: '#1A1D2F',
      surfaceMuted: '#22263A',
      text: '#F5F6FF',
      textSecondary: '#C0C4DF',
      border: '#34394F',
      borderStrong: '#555B76',
      primary: '#8AA2FF',
      primaryHover: '#A4B7FF',
      primaryActive: '#6F87E6',
      primaryShadow: '0 10px 24px rgba(138, 162, 255, 0.22)',
      focusShadow: '0 0 0 3px rgba(138, 162, 255, 0.22)',
      navigation: '#FF8C78',
      success: '#63C999',
      warning: '#E5A366',
      danger: '#ED818C',
      rowHoverBg: '#252B47',
      radiusSm: 12,
      radiusMd: 16,
      radiusLg: 22,
      shadow: '0 18px 44px rgba(0, 0, 0, 0.30)',
      shadowSecondary: '0 10px 24px rgba(0, 0, 0, 0.26)',
      menuItemColor: '#C8CCE5',
      menuHoverBg: '#242842',
      menuHoverColor: '#FFFFFF',
      menuSelectedBg: '#334EAF',
      menuSelectedColor: '#FFFFFF',
    },
  },
};

export function getModernUiTheme(mode: ThemeMode, variant: ModernUiVariant): ThemeConfig {
  const colors = palettes[variant][mode];
  const focusOutlineColor = getFocusOutlineColor(colors);

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
      borderRadius: colors.radiusMd,
      borderRadiusLG: colors.radiusLg,
      borderRadiusSM: colors.radiusSm,
      fontFamily: 'Inter, "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 14,
      boxShadow: colors.shadow,
      boxShadowSecondary: colors.shadowSecondary,
    },
    components: {
      Button: {
        controlHeight: 40,
        borderRadius: colors.radiusMd,
        primaryShadow: colors.primaryShadow,
        fontWeight: 650,
      },
      Input: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeShadow: colors.focusShadow,
      },
      Select: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeOutlineColor: focusOutlineColor,
      },
      DatePicker: {
        activeBorderColor: colors.primary,
        hoverBorderColor: colors.borderStrong,
        activeShadow: colors.focusShadow,
      },
      Table: {
        headerBg: colors.surfaceMuted,
        headerColor: colors.textSecondary,
        rowHoverBg: colors.rowHoverBg,
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
        darkItemColor: colors.menuItemColor,
        darkItemHoverBg: colors.menuHoverBg,
        darkItemHoverColor: colors.menuHoverColor,
        darkItemSelectedBg: colors.menuSelectedBg,
        darkItemSelectedColor: colors.menuSelectedColor,
      },
    },
  };
}

export function getEvolutionTheme(mode: ThemeMode): ThemeConfig {
  return getModernUiTheme(mode, 'evolution');
}

function getFocusOutlineColor(colors: ModernUiPalette): string {
  return colors.focusShadow.match(/rgba?\([^)]+\)/)?.[0] ?? colors.primary;
}
