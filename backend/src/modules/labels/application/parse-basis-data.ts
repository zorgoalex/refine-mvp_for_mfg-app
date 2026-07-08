export interface ParsedBasisData {
  position?: string;
  designation?: string;
  name?: string;
  raw: string;
}

export function parseBasisData(value: string | null | undefined): ParsedBasisData {
  const raw = typeof value === 'string' ? normalizeWhitespace(value) : '';
  if (!raw) {
    return { raw: '' };
  }

  const firstSlash = raw.indexOf('/');
  const secondSlash = firstSlash >= 0 ? raw.indexOf('/', firstSlash + 1) : -1;
  if (firstSlash > 0 && secondSlash > firstSlash + 1) {
    const position = raw.slice(0, firstSlash);
    const designation = raw.slice(firstSlash + 1, secondSlash);
    const name = raw.slice(secondSlash + 1);
    return { raw, position, designation, name };
  }

  const withPosition = /^(?<position>\d+(?:[.,]\d+)?|[A-Za-zА-Яа-я]\d+(?:[.-]\d+)?)\s+(.+)$/.exec(raw);
  const withoutPosition = withPosition?.[2] ?? raw;
  const result: ParsedBasisData = { raw };

  if (withPosition?.groups?.position) {
    result.position = withPosition.groups.position;
  }

  const designationMatch = /^(?<designation>[A-Za-zА-Яа-я0-9_.-]{2,})\s+[-–—]\s+(?<name>.+)$/.exec(withoutPosition);
  if (designationMatch?.groups) {
    result.designation = designationMatch.groups.designation;
    result.name = designationMatch.groups.name;
    return result;
  }

  const colonMatch = /^(?:поз\.?\s*)?(?<position>\d+[A-Za-zА-Яа-я]?)\s*[:;]\s*(?<name>.+)$/i.exec(raw);
  if (colonMatch?.groups) {
    result.position = result.position ?? colonMatch.groups.position;
    result.name = colonMatch.groups.name;
    return result;
  }

  if (!result.position && /^\d+[A-Za-zА-Яа-я]?$/.test(raw)) {
    result.position = raw;
  }

  return result;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
