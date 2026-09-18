/** Decode supported XML encodings identically in browser preview and backend. */
export function decodeXmlText(bytes: Uint8Array): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f) encoding = 'utf-16le';
  else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0) encoding = 'utf-16be';
  else {
    const prefix = Array.from(bytes.subarray(0, 256), b => String.fromCharCode(b)).join('');
    const declared = /<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(prefix)?.[1].toLowerCase();
    if (declared) {
      const aliases: Record<string, string> = { 'utf-8': 'utf-8', utf8: 'utf-8', 'windows-1251': 'windows-1251', cp1251: 'windows-1251', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be' };
      encoding = aliases[declared];
      if (!encoding) throw new Error(`Неподдерживаемая кодировка XML: ${declared}`);
    }
  }
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error(`Не удалось прочитать XML в кодировке ${encoding}`); }
}

export function assertSafeXml(text: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPE запрещён');
}
