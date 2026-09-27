import type {
  MdfPublishedCardPresentation,
  MdfSourceKind,
} from '../../api/types/mdfPublishedApi.types';

/** §5.6f: in a rework comment, a file name matching a program/file name of a packet loaded in the
 * snapshot becomes a link that focuses that card; unmatched names stay plain text. */
export interface MdfCommentLinkCandidate {
  kind: MdfSourceKind;
  id: string;
  /** Distinct, non-empty names this card is known by (programName, externalKey, ...). */
  names: readonly string[];
}

export interface MdfCommentTextSegment {
  kind: 'text';
  text: string;
}
export interface MdfCommentLinkSegment {
  kind: 'link';
  text: string;
  target: { kind: MdfSourceKind; id: string };
}
export type MdfCommentSegment = MdfCommentTextSegment | MdfCommentLinkSegment;

/** Only packets carry program/file names today; a card is a candidate only when its (not stale,
 * fully visible) composition names it. */
export function collectMdfCommentLinkCandidates(
  presentation: readonly MdfPublishedCardPresentation[],
): MdfCommentLinkCandidate[] {
  const candidates: MdfCommentLinkCandidate[] = [];
  for (const card of presentation) {
    if (card.stale || card.kind !== 'packet' || !card.composition) continue;
    const names = [card.composition.programName, card.composition.externalKey]
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim());
    if (names.length > 0) candidates.push({ kind: card.kind, id: card.id, names: [...new Set(names)] });
  }
  return candidates;
}

/** Best-effort defensive coercion of the raw `live.comments` JSON to a flat list of comment
 * strings. The backend column is a JSON blob (legacy shape: string[]); anything else renders
 * nothing rather than throwing. */
export function parseMdfLiveComments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/** Splits `text` into plain-text and link segments. Longest candidate names are matched first
 * (so a longer file name is never shadowed by a shorter substring of another candidate), matches
 * are case-insensitive, and matched spans never overlap. */
export function extractMdfCommentFileLinks(
  text: string,
  candidates: readonly MdfCommentLinkCandidate[],
): MdfCommentSegment[] {
  const entries = candidates
    .flatMap((candidate) => candidate.names.map((name) => ({ name, target: { kind: candidate.kind, id: candidate.id } })))
    .filter((entry) => entry.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  if (entries.length === 0 || !text) return text ? [{ kind: 'text', text }] : [];

  const segments: MdfCommentSegment[] = [];
  let cursor = 0;
  const haystack = text.toLocaleLowerCase('ru-RU');
  while (cursor < text.length) {
    let bestIndex = -1;
    let bestEntry: (typeof entries)[number] | null = null;
    for (const entry of entries) {
      const needle = entry.name.toLocaleLowerCase('ru-RU');
      const index = haystack.indexOf(needle, cursor);
      if (index === -1) continue;
      if (bestIndex === -1 || index < bestIndex
        || (index === bestIndex && entry.name.length > (bestEntry?.name.length ?? 0))) {
        bestIndex = index;
        bestEntry = entry;
      }
    }
    if (bestIndex === -1 || !bestEntry) {
      segments.push({ kind: 'text', text: text.slice(cursor) });
      break;
    }
    if (bestIndex > cursor) segments.push({ kind: 'text', text: text.slice(cursor, bestIndex) });
    const matchEnd = bestIndex + bestEntry.name.length;
    segments.push({ kind: 'link', text: text.slice(bestIndex, matchEnd), target: bestEntry.target });
    cursor = matchEnd;
  }
  return segments;
}
