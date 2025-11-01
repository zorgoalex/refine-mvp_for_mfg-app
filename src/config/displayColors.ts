/**
 * Centralized color configuration for materials and milling types display
 *
 * This configuration allows easy customization of colors used across the application
 * for visual identification of materials and milling types.
 */

// Material text colors (used in header summary and details table)
export const MATERIAL_COLORS: Record<string, string> = {
  'МДФ 18': '#0000ff',      // blue
  'МДФ 16': '#000000',      // black
  'МДФ 10': '#8b4513',      // brown (saddle brown)
  'МДФ 8': '#008000',       // green
  'ЛДСП': '#8b00ff',        // purple (violet)
  'DEFAULT': '#00bfff',     // cyan (default for unknown materials)
};

// Milling type background colors (used in details table)
export const MILLING_BG_COLORS: Record<string, string> = {
  'ВЫБОРКА_НЕОКЛ': '#ffffe0',    // light yellow (for types containing "выборка" or "неокл")
  'SPECIAL': '#d4f4d4',          // very light green (for all other types except "модерн")
  'МОДЕРН': 'transparent',       // no background for "модерн"
  'DEFAULT': 'transparent',      // default (no background)
};

/**
 * Get material text color based on material name
 * @param materialName - Name of the material
 * @returns Hex color code
 */
export const getMaterialColor = (materialName: string): string => {
  if (!materialName) return MATERIAL_COLORS.DEFAULT;

  const name = materialName.toUpperCase();

  // Check for specific material types
  if (name.includes('МДФ 18')) return MATERIAL_COLORS['МДФ 18'];
  if (name.includes('МДФ 16')) return MATERIAL_COLORS['МДФ 16'];
  if (name.includes('МДФ 10')) return MATERIAL_COLORS['МДФ 10'];
  if (name.includes('МДФ 8')) return MATERIAL_COLORS['МДФ 8'];
  if (name.includes('ЛДСП')) return MATERIAL_COLORS['ЛДСП'];

  return MATERIAL_COLORS.DEFAULT;
};

/**
 * Get milling type background color based on milling type name
 * @param millingTypeName - Name of the milling type
 * @returns Hex color code
 */
export const getMillingBgColor = (millingTypeName: string): string => {
  if (!millingTypeName) return MILLING_BG_COLORS.DEFAULT;

  const name = millingTypeName.toLowerCase();

  // "модерн" gets no background
  if (name === 'модерн') return MILLING_BG_COLORS['МОДЕРН'];

  // Types containing "выборка" or "неокл" get light yellow
  if (name.includes('выборка') || name.includes('неокл')) {
    return MILLING_BG_COLORS['ВЫБОРКА_НЕОКЛ'];
  }

  // All other types get light green
  return MILLING_BG_COLORS['SPECIAL'];
};
