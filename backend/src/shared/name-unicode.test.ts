import { describe, expect, it } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { humanName } from './human-name-schema';
import { decodeXmlText } from './xml-text';
import { parseBazisXml } from '../modules/bazis/application/bazis-xml-parser';
import { attachmentDisposition } from '../common/http/content-disposition';
import { decodeUploadedFileName, parseRenameProjectBody } from '../modules/bazis/http/bazis.controller';
import { validateRenderPresetInput } from '../modules/cut/application/cut-config-validation';
import { parsePreset } from '../modules/cut/http/cut.controller';

const xml = '<?xml version="1.0" encoding="utf-8"?><Проект Наименование="Тест &amp; Ёлка"><Изделие><Наименование>Кухня &quot;Әлия&quot;</Наименование></Изделие></Проект>';

describe('Unicode business names', () => {
  it.each(['Тест Ёлка', 'Әлия Асүй', '00123', 'A/B: 100% + 0,4', '"Стол" & стул'])('preserves %s', name => {
    expect(humanName(200).parse(` ${name} `)).toBe(name);
  });
  it.each(['\0', '\n', '\t', '\r', '\u007f'])('rejects control %j before trim', control => {
    expect(humanName(200).safeParse(`Тест${control}`).success).toBe(false);
  });
  it('uses the same Unicode preset contract for writes and rendering', () => {
    const name = 'Большой экран / Әлия % 100';
    expect(validateRenderPresetInput({ name, targetPx: 1400 }).name).toBe(parsePreset(name));
    expect(parsePreset('Я'.repeat(100))).toHaveLength(100);
    expect(() => parsePreset('Я'.repeat(101))).toThrow();
  });
  it('allows renaming long names imported from XML', () => {
    expect(parseRenameProjectBody({ name: 'Я'.repeat(400) }).name).toHaveLength(400);
  });
  it('repairs legacy multipart bytes, preserving already decoded names', () => {
    expect(decodeUploadedFileName(Buffer.from('Тест Ёлка.xml').toString('latin1'))).toBe('Тест Ёлка.xml');
    expect(decodeUploadedFileName('Тест.xml')).toBe('Тест.xml');
    expect(decodeUploadedFileName('café.xml')).toBe('café.xml');
  });
  it('produces valid HTTP headers and lossless UTF-8 filename', () => {
    const name = 'Тест "Әлия"; 100%.json';
    const header = attachmentDisposition(name);
    expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
    expect(decodeURIComponent(header.split("UTF-8''")[1])).toBe(name);
  });
});

describe('Bazis XML encoding and entities', () => {
  it.each(['utf8', 'utf16le'] as const)('decodes %s and built-in entities', encoding => {
    const source = encoding === 'utf16le' ? '\uFEFF' + xml.replace('utf-8', 'utf-16') : xml;
    const bytes = Buffer.from(source, encoding);
    expect(decodeXmlText(bytes)).toContain('Проект');
    expect(parseBazisXml(bytes)).toMatchObject({ bazisOrderNo: 'Тест & Ёлка', productName: 'Кухня "Әлия"' });
  });
  it('decodes windows-1251 and UTF-16BE', () => {
    const source = '<?xml version="1.0" encoding="windows-1251"?><Проект Наименование="Тест"><Изделие><Наименование>Тест</Наименование></Изделие></Проект>';
    const bytes = Uint8Array.from(source, char => char.charCodeAt(0) >= 0x410 ? char.charCodeAt(0) - 0x410 + 0xc0 : char.charCodeAt(0));
    expect(parseBazisXml(Buffer.from(bytes)).bazisOrderNo).toBe('Тест');
    const be = Buffer.from('\uFEFF' + xml.replace('utf-8', 'utf-16'), 'utf16le').swap16();
    expect(parseBazisXml(be).bazisOrderNo).toBe('Тест & Ёлка');
  });
  it('rejects DTD beyond the old 4096-byte inspection window', () => {
    expect(() => parseBazisXml(' '.repeat(5000) + '<!DOCTYPE a [<!ENTITY x "boom">]>' + xml)).toThrow('DOCTYPE');
  });
  it('rejects malformed and unsupported encodings clearly', () => {
    expect(() => decodeXmlText(Uint8Array.from([0xff, 0xff]))).toThrow('кодировке');
    expect(() => decodeXmlText(Buffer.from('<?xml encoding="koi8-r"?>'))).toThrow('Неподдерживаемая');
  });
});
