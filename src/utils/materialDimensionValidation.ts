/**
 * Утилита для валидации размеров деталей в зависимости от типа материала
 *
 * Правила валидации:
 * 1. МДФ и ЛДСП 2800x2070: max(height, width) <= 2800 && min(height, width) <= 2070
 * 2. ЛДСП 2750x1830: max(height, width) <= 2750 && min(height, width) <= 1830
 */

export interface MaterialInfo {
  material_id: number;
  material_name: string;
  material_type_id?: number;
  material_type_name?: string;
}

export interface DimensionLimits {
  maxDimension: number;
  minDimensionLimit: number;
  sheetType: string;
}

/**
 * Определяет лимиты размеров для материала
 */
export function getMaterialDimensionLimits(material: MaterialInfo | null): DimensionLimits | null {
  if (!material) return null;

  const materialName = material.material_name?.toLowerCase() || '';
  const materialTypeName = material.material_type_name?.toLowerCase() || '';

  // Проверка на МДФ (любой размер листа стандартного МДФ - 2800x2070)
  if (materialTypeName.includes('мдф') || materialTypeName.includes('mdf')) {
    return {
      maxDimension: 2800,
      minDimensionLimit: 2070,
      sheetType: 'МДФ 2800×2070 мм'
    };
  }

  // Проверка на ЛДСП 2750x1830
  if (materialTypeName.includes('лдсп') || materialTypeName.includes('ldsp')) {
    // Проверяем название материала на наличие указания размера
    if (materialName.includes('2750') || materialName.includes('1830')) {
      return {
        maxDimension: 2750,
        minDimensionLimit: 1830,
        sheetType: 'ЛДСП 2750×1830 мм'
      };
    }

    // По умолчанию ЛДСП - 2800x2070
    return {
      maxDimension: 2800,
      minDimensionLimit: 2070,
      sheetType: 'ЛДСП 2800×2070 мм'
    };
  }

  // Для других материалов нет ограничений
  return null;
}

export interface DimensionValidationResult {
  isValid: boolean;
  errorMessage?: string;
  limits?: DimensionLimits;
}

/**
 * Валидирует размеры детали в зависимости от материала
 *
 * @param height - высота детали в мм
 * @param width - ширина детали в мм
 * @param material - информация о материале
 * @returns результат валидации с сообщением об ошибке
 */
export function validateMaterialDimensions(
  height: number | null | undefined,
  width: number | null | undefined,
  material: MaterialInfo | null
): DimensionValidationResult {
  // Если размеры не указаны или материал не выбран, валидация не применяется
  if (!height || !width || !material) {
    return { isValid: true };
  }

  const limits = getMaterialDimensionLimits(material);

  // Если для материала нет ограничений
  if (!limits) {
    return { isValid: true };
  }

  const maxSize = Math.max(height, width);
  const minSize = Math.min(height, width);

  // Проверка: только один из размеров может быть равен maxDimension
  if (height === limits.maxDimension && width === limits.maxDimension) {
    return {
      isValid: false,
      errorMessage: `Оба размера не могут быть ${limits.maxDimension} мм одновременно (${limits.sheetType})`,
      limits
    };
  }

  // Проверка: если один из размеров = maxDimension, второй не может превышать minDimensionLimit
  if (maxSize === limits.maxDimension && minSize > limits.minDimensionLimit) {
    return {
      isValid: false,
      errorMessage: `Если один размер = ${limits.maxDimension} мм, второй не может превышать ${limits.minDimensionLimit} мм (${limits.sheetType})`,
      limits
    };
  }

  // Проверка: максимальный размер не должен превышать maxDimension
  if (maxSize > limits.maxDimension) {
    return {
      isValid: false,
      errorMessage: `Размер ${maxSize} мм превышает максимальный размер листа ${limits.maxDimension} мм (${limits.sheetType})`,
      limits
    };
  }

  // Все проверки пройдены
  return { isValid: true, limits };
}

/**
 * Генерирует человекочитаемое описание ограничений для материала
 */
export function getMaterialDimensionDescription(material: MaterialInfo | null): string | null {
  const limits = getMaterialDimensionLimits(material);

  if (!limits) return null;

  return `Лист ${limits.sheetType}: максимальный размер ${limits.maxDimension} мм, при этом второй размер не может превышать ${limits.minDimensionLimit} мм`;
}
