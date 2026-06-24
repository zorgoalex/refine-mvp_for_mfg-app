export interface ParsedBasisDataView {
  position?: string;
  designation?: string;
  name?: string;
  raw: string;
}

export function parseBasisDataView(value: string | null | undefined): ParsedBasisDataView {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!raw) {
    return { raw: '' };
  }

  const withPosition = /^(?<position>\d+(?:[.,]\d+)?|[A-Za-zА-Яа-я]\d+(?:[.-]\d+)?)\s+(.+)$/.exec(raw);
  const withoutPosition = withPosition?.[2] ?? raw;
  const result: ParsedBasisDataView = { raw };

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
