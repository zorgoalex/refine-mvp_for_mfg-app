import { createHash } from 'node:crypto';

/**
 * Canonical JSON `agent-payload-sha256-base64-v1`, shared with the 1C agent
 * (PayloadHasher.cs) and the 1C extension (BSL):
 * - strict RFC 8259 input; duplicate keys (also case-only or escape-only
 *   duplicates) and unpaired surrogates are rejected;
 * - object keys sorted by UTF-16 code units (ordinal), array order kept;
 * - number lexemes kept verbatim (`1`, `1.0`, `1e0` differ);
 * - strings escaped like System.Text.Json Utf8JsonWriter with
 *   JavaScriptEncoder.Default (see escapeString);
 * - hash = base64(SHA-256(compact UTF-8 bytes)).
 * JSON.parse cannot be used: it loses number lexemes and silently keeps the
 * last duplicate key.
 */

export type JsonNode =
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; lexeme: string }
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'object'; entries: Array<[string, JsonNode]> };

export type CanonicalJsonErrorCode =
  | 'INVALID_JSON'
  | 'DUPLICATE_KEY'
  | 'UNPAIRED_SURROGATE'
  | 'UNSUPPORTED_VALUE'
  | 'TOO_DEEP';

export class CanonicalJsonError extends Error {
  constructor(readonly code: CanonicalJsonErrorCode, message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** Parser nesting guard (System.Text.Json default MaxDepth is 64). */
const MAX_PARSE_DEPTH = 64;
const NUMBER_LEXEME = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

export function parseStrictJson(text: string): JsonNode {
  const parser = new StrictParser(text);
  return parser.parseDocument();
}

/** Decodes UTF-8 bytes strictly (invalid UTF-8 or a BOM is rejected). */
export function parseStrictJsonBytes(bytes: Uint8Array): JsonNode {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CanonicalJsonError('INVALID_JSON', 'UTF-8 BOM is not allowed');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalJsonError('INVALID_JSON', 'Invalid UTF-8');
  }
  return parseStrictJson(text);
}

/**
 * Converts an in-memory ERP value into a JSON tree. Numbers must be safe
 * integers: fractional/monetary values travel as strings by contract.
 */
export function toJsonNode(value: unknown, depth = 0): JsonNode {
  if (depth > MAX_PARSE_DEPTH) throw new CanonicalJsonError('TOO_DEEP', 'Value is nested too deeply');
  if (value === null) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError('UNSUPPORTED_VALUE', 'Only safe integers are allowed as numbers');
    }
    return { kind: 'number', lexeme: String(value === 0 ? 0 : value) };
  }
  if (typeof value === 'string') {
    assertNoUnpairedSurrogate(value);
    return { kind: 'string', value };
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map((item) => toJsonNode(item, depth + 1)) };
  if (typeof value === 'object') {
    const entries: Array<[string, JsonNode]> = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      assertNoUnpairedSurrogate(key);
      entries.push([key, toJsonNode(item, depth + 1)]);
    }
    assertUniqueKeys(entries.map(([key]) => key));
    return { kind: 'object', entries };
  }
  throw new CanonicalJsonError('UNSUPPORTED_VALUE', `Unsupported value type: ${typeof value}`);
}

export function canonicalize(node: JsonNode): string {
  switch (node.kind) {
    case 'null':
      return 'null';
    case 'bool':
      return node.value ? 'true' : 'false';
    case 'number':
      return node.lexeme;
    case 'string':
      return escapeString(node.value);
    case 'array':
      return `[${node.items.map(canonicalize).join(',')}]`;
    case 'object': {
      const sorted = [...node.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${sorted.map(([key, value]) => `${escapeString(key)}:${canonicalize(value)}`).join(',')}}`;
    }
  }
}

export function sha256Base64(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('base64');
}

export interface CanonicalResult {
  node: JsonNode;
  canonical: string;
  hash: string;
  bytes: number;
}

export function canonicalizeText(text: string): CanonicalResult {
  return finish(parseStrictJson(text));
}

export function canonicalizeValue(value: unknown): CanonicalResult {
  return finish(toJsonNode(value));
}

function finish(node: JsonNode): CanonicalResult {
  const canonical = canonicalize(node);
  return { node, canonical, hash: sha256Base64(canonical), bytes: Buffer.byteLength(canonical, 'utf8') };
}

export interface JsonShapeStats {
  /** Deepest container nesting; a scalar root has depth 0, `{}` has depth 1. */
  depth: number;
  /** Every value node, containers included. */
  nodes: number;
  /** Largest number of fields in one object. */
  maxObjectFields: number;
}

export function measureJson(node: JsonNode): JsonShapeStats {
  const stats: JsonShapeStats = { depth: 0, nodes: 0, maxObjectFields: 0 };
  const visit = (current: JsonNode, depth: number) => {
    stats.nodes += 1;
    if (current.kind === 'array') {
      stats.depth = Math.max(stats.depth, depth + 1);
      for (const item of current.items) visit(item, depth + 1);
    } else if (current.kind === 'object') {
      stats.depth = Math.max(stats.depth, depth + 1);
      stats.maxObjectFields = Math.max(stats.maxObjectFields, current.entries.length);
      for (const [, item] of current.entries) visit(item, depth + 1);
    }
  };
  visit(node, 0);
  return stats;
}

/** Converts a JSON tree back into a plain JS value (numbers as JS numbers). */
export function toPlainValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null':
      return null;
    case 'bool':
      return node.value;
    case 'number':
      return Number(node.lexeme);
    case 'string':
      return node.value;
    case 'array':
      return node.items.map(toPlainValue);
    case 'object':
      return Object.fromEntries(node.entries.map(([key, value]) => [key, toPlainValue(value)]));
  }
}

/**
 * Utf8JsonWriter + JavaScriptEncoder.Default: printable Basic Latin stays
 * literal except the HTML-sensitive `"&'+<>` and backtick; `\b\t\n\f\r\\`
 * use short escapes; every other code unit (controls, DEL, all non-ASCII,
 * each half of a surrogate pair) becomes `\uXXXX` with upper-case hex.
 */
export function escapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += '\\b';
        continue;
      case 0x09:
        out += '\\t';
        continue;
      case 0x0a:
        out += '\\n';
        continue;
      case 0x0c:
        out += '\\f';
        continue;
      case 0x0d:
        out += '\\r';
        continue;
      case 0x5c:
        out += '\\\\';
        continue;
      default:
        break;
    }
    const htmlSensitive =
      code === 0x22 || code === 0x26 || code === 0x27 || code === 0x2b || code === 0x3c || code === 0x3e || code === 0x60;
    if (code >= 0x20 && code <= 0x7e && !htmlSensitive) {
      out += value[i];
    } else {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return `${out}"`;
}

/** Case-insensitive key identity approximating .NET OrdinalIgnoreCase (per-code-unit simple upper-casing). */
export function foldKey(key: string): string {
  let out = '';
  for (const ch of key) {
    const upper = ch.toUpperCase();
    out += upper.length === ch.length ? upper : ch;
  }
  return out;
}

function assertUniqueKeys(keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    const folded = foldKey(key);
    if (seen.has(folded)) throw new CanonicalJsonError('DUPLICATE_KEY', 'Duplicate object key');
    seen.add(folded);
  }
}

function assertNoUnpairedSurrogate(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      throw new CanonicalJsonError('UNPAIRED_SURROGATE', 'Unpaired UTF-16 surrogate');
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('UNPAIRED_SURROGATE', 'Unpaired UTF-16 surrogate');
    }
  }
}

class StrictParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    this.skipWhitespace();
    const node = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) this.fail('Unexpected trailing content');
    return node;
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_PARSE_DEPTH) throw new CanonicalJsonError('TOO_DEEP', 'JSON is nested too deeply');
    const ch = this.text[this.pos];
    if (ch === '{') return this.parseObject(depth);
    if (ch === '[') return this.parseArray(depth);
    if (ch === '"') return { kind: 'string', value: this.parseString() };
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 4;
      return { kind: 'bool', value: true };
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 5;
      return { kind: 'bool', value: false };
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 4;
      return { kind: 'null' };
    }
    return this.fail('Unexpected token');
  }

  private parseObject(depth: number): JsonNode {
    this.pos += 1;
    const entries: Array<[string, JsonNode]> = [];
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail('Expected object key');
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') this.fail('Expected ":"');
      this.pos += 1;
      this.skipWhitespace();
      entries.push([key, this.parseValue(depth + 1)]);
      this.skipWhitespace();
      const sep = this.text[this.pos];
      this.pos += 1;
      if (sep === '}') break;
      if (sep !== ',') this.fail('Expected "," or "}"');
    }
    assertUniqueKeys(entries.map(([key]) => key));
    return { kind: 'object', entries };
  }

  private parseArray(depth: number): JsonNode {
    this.pos += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const sep = this.text[this.pos];
      this.pos += 1;
      if (sep === ']') break;
      if (sep !== ',') this.fail('Expected "," or "]"');
    }
    return { kind: 'array', items };
  }

  private parseNumber(): JsonNode {
    const start = this.pos;
    while (this.pos < this.text.length && /[0-9eE+\-.]/.test(this.text[this.pos]!)) this.pos += 1;
    const lexeme = this.text.slice(start, this.pos);
    if (!NUMBER_LEXEME.test(lexeme)) this.fail('Invalid number');
    return { kind: 'number', lexeme };
  }

  private parseString(): string {
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) this.fail('Unterminated string');
      const ch = this.text[this.pos]!;
      const code = ch.charCodeAt(0);
      if (ch === '"') {
        this.pos += 1;
        break;
      }
      if (code < 0x20) this.fail('Unescaped control character in string');
      if (ch !== '\\') {
        out += ch;
        this.pos += 1;
        continue;
      }
      const esc = this.text[this.pos + 1];
      this.pos += 2;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail('Invalid escape');
      }
    }
    assertNoUnpairedSurrogate(out);
    return out;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') this.pos += 1;
      else break;
    }
  }

  private fail(message: string): never {
    throw new CanonicalJsonError('INVALID_JSON', `${message} at offset ${this.pos}`);
  }
}
