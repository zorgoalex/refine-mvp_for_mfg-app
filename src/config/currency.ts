// Currency configuration
// Can be changed based on application settings

/**
 * Currency symbol used throughout the application
 * Default: ₸ (Tenge)
 * Can be configured via environment variable or application settings
 */
export const CURRENCY_SYMBOL = (import.meta as any).env.VITE_CURRENCY_SYMBOL ?? '₸';

/**
 * Currency code (ISO 4217)
 * Default: KZT (Kazakh Tenge)
 */
export const CURRENCY_CODE = (import.meta as any).env.VITE_CURRENCY_CODE ?? 'KZT';

/**
 * Currency name for display
 */
export const CURRENCY_NAME = (import.meta as any).env.VITE_CURRENCY_NAME ?? 'тенге';
