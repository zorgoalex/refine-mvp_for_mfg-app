/**
 * Service lines ERP appends to a Bitrix24 Contact/Company comment (see mapClient). They are ERP's own
 * markers, not client notes: the comment comes back through the reverse sync, so they must never
 * reach `clients.notes`, and lines that already did must not be sent to Bitrix24 a second time.
 *
 * The rule is kept character-for-character in step with the one-off SQL cleanup of production notes:
 * blanks are exactly space, tab and no-break space; shared cases live in bitrix24-client-notes.fixtures.json.
 */
const BLANK = '[ \\t\\u00a0]';
const EDGE_BLANKS = new RegExp(`^${BLANK}+|${BLANK}+$`, 'gu');
const ERP_SERVICE_LINE = new RegExp(
  `^(?:ERP ID клиента${BLANK}*[:\\-–—]${BLANK}*[0-9]+|Статус ERP:${BLANK}*неактивен)$`,
  'iu',
);

const ERP_INACTIVE_LINE = new RegExp(`^Статус ERP:${BLANK}*неактивен$`, 'iu');

/** Lines of a Bitrix24 comment: unified line breaks, BB-code paragraphs as breaks, blanks trimmed. */
function commentLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\[br\]/giu, '\n')
    .replace(/\[\/?p\]/giu, '\n')
    .split('\n')
    .map((line) => line.replace(EDGE_BLANKS, ''));
}

/**
 * Client notes without ERP service lines and without the Bitrix24 BB-code paragraph markup
 * (`[p]…[/p]`, `[br]`) the Bitrix24 editor wraps comments in. Lines are trimmed, runs of blank
 * lines collapse to one, an empty result is null. Never truncates: a length limit is the caller's.
 */
export function clientNotesWithoutErpLines(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const kept: string[] = [];
  for (const line of commentLines(value)) {
    if (ERP_SERVICE_LINE.test(line)) continue;
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.length > 0 ? kept.join('\n') : null;
}

/**
 * True when the comment carries ERP's own «Статус ERP: неактивен» line, i.e. it is ERP's projection of
 * an inactive client coming back as an echo; the reverse sync must not reactivate the client from it.
 */
export function commentMarksErpClientInactive(value: unknown): boolean {
  return typeof value === 'string' && commentLines(value).some((line) => ERP_INACTIVE_LINE.test(line));
}
