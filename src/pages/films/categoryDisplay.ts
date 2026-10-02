// 1С хранит категории номенклатуры заглавными («ПЛЕНКА ПВХ ДЛЯ МДФ»): в списке они выглядят крупнее остального
// текста. Показываем в обычном регистре, сохраняя аббревиатуры; значение в базе не меняется.
const ABBREVIATIONS = new Set(['ПВХ', 'МДФ', 'ЛДСП', 'ХДФ', 'ДСП', 'ДВП', 'ПЭТ', 'АБС', 'HPL', 'ABS', 'PVC', 'PET', 'MDF']);

export function categoryDisplay(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  // Трогаем только значения целиком в верхнем регистре: смешанный регистр уже набран как надо.
  if (text === '' || text !== text.toUpperCase() || text === text.toLowerCase()) return text;
  let first = true;
  return text.split(/(\s+)/).map((token) => {
    if (/^\s*$/.test(token)) return token;
    const bare = token.replace(/[^\p{L}\p{N}]/gu, '');
    const keep = ABBREVIATIONS.has(bare) || /\d/.test(token);
    const lower = keep ? token : token.toLowerCase();
    const shown = first && !keep ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    first = false;
    return shown;
  }).join('');
}
