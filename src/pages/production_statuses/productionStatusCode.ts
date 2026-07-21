const MAX_PRODUCTION_STATUS_CODE_LENGTH = 64;

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  ә: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ғ: 'gh',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  қ: 'q',
  л: 'l',
  м: 'm',
  н: 'n',
  ң: 'ng',
  о: 'o',
  ө: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ұ: 'u',
  ү: 'u',
  ў: 'u',
  ф: 'f',
  х: 'kh',
  һ: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const createUniqueSuffix = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replaceAll('-', '');
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const generateProductionStatusCode = (
  name: string,
  uniqueSuffix = createUniqueSuffix(),
): string => {
  const source = name.trim().toLowerCase();
  const transliterated = Array.from(source, (character) => (
    CYRILLIC_TO_LATIN[character] ?? character
  )).join('').normalize('NFKD');
  const slug = transliterated
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  const readablePrefix = slug.length === 0
    ? 'status'
    : /^[a-z]/.test(slug)
      ? slug
      : `status_${slug}`;
  const suffix = uniqueSuffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32) || 'generated';
  const maxPrefixLength = MAX_PRODUCTION_STATUS_CODE_LENGTH - suffix.length - 1;
  const limitedPrefix = readablePrefix
    .slice(0, maxPrefixLength)
    .replace(/_+$/g, '');

  return `${limitedPrefix || 'status'}_${suffix}`;
};
