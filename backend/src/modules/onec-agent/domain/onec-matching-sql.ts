/** SQL expressions shared by everything that compares 1C counterparties with ERP clients and suppliers. */

/**
 * Lowercase, drop quotes and legal-form words, collapse everything but letters/digits to single spaces.
 * Kazakh letters (ә ғ қ ң ө ұ ү һ і) are letters: «Қанат» and «Ғанат» stay different.
 */
export const normalizedName = (expr: string) =>
  `btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(${expr}, '')), '[«»"''“”„\`]', '', 'g'),
     '(^|\\s)(тоо|ип|ао|оао|зао|ооо|пк|кх|too|llp|ip)(?=\\s|$)', ' ', 'g'), '[^0-9a-zа-яёәғқңөұүһі]+', ' ', 'g'))`;
/**
 * KZ numbers: all digits, the first 11 (an extension typed after the number is dropped), then the last
 * 10 (+7 / 8 prefix does not matter). "+7 (701) 555-44-33", "87015554433", "87015554433-123" → 7015554433.
 */
export const normalizedPhone = (expr: string) => `right(left(regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g'), 11), 10)`;
