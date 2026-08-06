const DOWELING_WORD_RE = /(^|[^\p{L}\p{N}_])присадка(?=$|[^\p{L}\p{N}_])/iu;

export function noteRequiresDoweling(note: unknown): boolean {
  return typeof note === 'string' && DOWELING_WORD_RE.test(note);
}
