import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';

const code = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const name = z.string().trim().min(1).max(120);
const phrases = z.array(z.string().trim().min(1).max(100)).max(50);
export const configurationSchema = z.object({
  version: z.number().int().positive(),
  sources: z.array(z.object({
    code, name, channel: z.literal('whatsapp'), connection: z.string().trim().min(1).max(100),
    chatId: z.string().regex(/^\d+(?:-\d+)?@g\.us$/), enabled: z.boolean(),
  }).strict()).max(100),
  signals: z.array(z.object({ code, name }).strict()).max(200),
  resolvers: z.array(z.object({
    code, name, target: z.enum(['order_id', 'order_name', 'cut_id', 'project_code']),
    prefixes: phrases.min(1), format: z.enum(['digits', 'code']),
  }).strict()).max(100),
  rules: z.array(z.object({
    code, name, sourceCodes: z.array(code).min(1).max(100), signalCode: code,
    resolverCode: code, keywords: phrases.min(1), exclusions: phrases,
    matchMode: z.enum(['phrase', 'contains', 'exact']), enabled: z.boolean(),
    priority: z.number().int().min(0).max(10000),
  }).strict()).max(300),
}).strict().superRefine((config, ctx) => {
  for (const kind of ['sources', 'signals', 'resolvers', 'rules'] as const) {
    const seen = new Set<string>();
    for (const entry of config[kind]) {
      if (seen.has(entry.code)) ctx.addIssue({ code: 'custom', path: [kind], message: 'Коды должны быть уникальны' });
      seen.add(entry.code);
    }
  }
  const sourceKeys = config.sources.map(s => JSON.stringify([s.channel, s.connection, s.chatId]));
  if (new Set(sourceKeys).size !== sourceKeys.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Группа уже подключена' });
  for (const rule of config.rules) {
    if (!config.signals.some(s => s.code === rule.signalCode)
      || !config.resolvers.some(r => r.code === rule.resolverCode)
      || rule.sourceCodes.some(s => !config.sources.some(source => source.code === s))) {
      ctx.addIssue({ code: 'custom', path: ['rules'], message: 'Правило ссылается на отсутствующий источник, сигнал или шаблон' });
    }
  }
});
export type SignalConfiguration = z.infer<typeof configurationSchema>;
export type Resolver = SignalConfiguration['resolvers'][number];
export const emptyConfiguration: SignalConfiguration = { version: 1, sources: [], signals: [], resolvers: [], rules: [] };
export function parseConfiguration(body: unknown): SignalConfiguration {
  const parsed = configurationSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(422, 'SIGNAL_CONFIGURATION_INVALID', 'Проверьте настройки обработки сообщений', {
    errors: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
  });
  return parsed.data;
}
export interface InboundMessage {
  channel: string; connection: string; chatId: string; externalId: string;
  sender: string; text: string; sentAt: Date;
}
const wahaEnvelope = z.object({
  event: z.literal('message'), session: z.string(), payload: z.object({
    id: z.string().min(1).max(1024), from: z.string().max(160), fromMe: z.literal(false),
    timestamp: z.number().positive(), participant: z.string().max(160).optional(),
    body: z.string().max(16000).nullish(), caption: z.string().max(16000).nullish(),
  }),
});
export function parseWahaGroup(body: unknown, session: string): InboundMessage | null {
  const parsed = wahaEnvelope.safeParse(body);
  if (!parsed.success || parsed.data.session !== session) return null;
  const p = parsed.data.payload;
  if (!/^\d+(?:-\d+)?@g\.us$/.test(p.from)) return null;
  const text = p.body?.trim() || p.caption?.trim() || '';
  const sentAt = new Date(p.timestamp * 1000);
  if (!text || !Number.isFinite(sentAt.getTime())) return null;
  return { channel: 'whatsapp', connection: session, chatId: p.from, externalId: p.id,
    sender: p.participant ?? '', text, sentAt };
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function messageKey(message: InboundMessage): string {
  return digest([message.channel, message.connection, message.chatId, message.externalId]);
}
export function normalize(text: string): string {
  return text.replace(/№/gu, '#').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/gu, ' ').trim();
}
function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function matches(text: string, keyword: string, mode: 'phrase' | 'contains' | 'exact'): boolean {
  const input = normalize(text), key = normalize(keyword);
  if (mode === 'exact') return input === key;
  if (mode === 'contains') return input.includes(key);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(key)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(input);
}
export function matchRules(text: string, source: string, config: SignalConfiguration) {
  return config.rules.filter(r => r.enabled && r.sourceCodes.includes(source)
    && !r.exclusions.some(p => matches(text, p, 'phrase'))
    && r.keywords.some(p => matches(text, p, r.matchMode)))
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}
export function extractReferences(text: string, resolver: Resolver): string[] {
  const input = normalize(text);
  const value = resolver.format === 'digits' ? '(\\d{1,18})' : '([\\p{L}\\p{N}][\\p{L}\\p{N}_.\\/-]{0,79})';
  const values = new Set<string>();
  for (const prefix of resolver.prefixes) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalize(prefix))}\\s*[:№#-]?\\s*${value}(?![\\p{L}\\p{N}_/.-])`, 'gu');
    for (const match of input.matchAll(re)) {
      if (match[1]) values.add(match[1]);
      // Keep the overflow sentinel; silently truncating could hide ambiguity.
      if (values.size > 20) return [...values];
    }
  }
  return [...values];
}

// ---------------------------------------------------------------------------------------------------------------------
// Several signals in one message (plan spec_erp/plans/whatsapp/2026-11-02-inbound-signals-multi-order-plan.md).
// The message decides which rules fired, exactly as before (matchRules on the whole text). A message is split only when
// it has several lines or a line with several numbers, no fired rule is «exact» (whole message), and some line carries a
// keyword on its own; otherwise the old single-occurrence path runs unchanged.

type Rule = SignalConfiguration['rules'][number];
export interface GroupReference { resolverCode: string; reference: string }
export interface SignalGroup {
  /** Position of the group in the message (0-based). */
  groupIndex: number;
  signalCode: string;
  ruleCodes: string[];
  /** The lines of the group as written (keyword line and its number lines). */
  text: string;
  references: GroupReference[];
}
export type SignalPlan = { kind: 'legacy' } | { kind: 'split'; groups: SignalGroup[]; tooMany: boolean };

/** Most references of one message; more → one occurrence for review. */
export const MAX_MESSAGE_REFERENCES = 20;

function valuePattern(resolver: Resolver): string {
  return resolver.format === 'digits' ? '\\d{1,18}' : '[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\/-]{0,79}';
}
/** After a value: no letter/digit/code char; for digits a dot is allowed only as the end of a sentence. */
function valueEnd(resolver: Resolver): string {
  return resolver.format === 'digits' ? '(?![\\p{L}\\p{N}_/-])(?!\\.[\\p{L}\\p{N}])' : '(?![\\p{L}\\p{N}_/.-])';
}
function listSeparator(resolver: Resolver): string {
  // «и» / «+» only between digits: in codes they could be a part of the text.
  return resolver.format === 'digits' ? '\\s*(?:,|;|\\+|\\sи\\s)\\s*' : '\\s*[,;]\\s*';
}

/**
 * References after a configured prefix, including a list after one prefix («Заказ 3046, 3051», «заказ 3053 и 3062»).
 * The single-reference `extractReferences` above stays the legacy path's extractor.
 */
export function extractReferenceList(text: string, resolver: Resolver): string[] {
  const input = normalize(text);
  const value = valuePattern(resolver), sep = listSeparator(resolver);
  const values: string[] = [];
  for (const prefix of resolver.prefixes) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalize(prefix))}\\s*[:№#-]?\\s*(${value}(?:${sep}${value})*)${valueEnd(resolver)}`, 'gu');
    for (const match of input.matchAll(re)) {
      for (const one of match[1].split(new RegExp(sep, 'u'))) if (one && !values.includes(one)) values.push(one);
    }
  }
  return values;
}

/** A line made of numbers only («3043», «#3065, 3066»): only for digit resolvers. */
const BARE_LINE = /^#?\s*\d{1,18}(?:\s*[,;]\s*#?\s*\d{1,18})*\s*[.,;!]?$/u;
function bareNumbers(line: string): string[] {
  const input = normalize(line);
  return BARE_LINE.test(input) ? [...input.matchAll(/\d{1,18}/gu)].map(m => m[0]) : [];
}
/**
 * A line made of a prefix and numbers only («Заказ 3046», «заказ 3046, 3051.»): its references, [] for any other line.
 * Classification and extraction use this one pattern, so an accepted line never loses a number.
 */
function prefixedLineReferences(line: string, resolver: Resolver): string[] {
  const input = normalize(line);
  const value = valuePattern(resolver), sep = listSeparator(resolver);
  for (const prefix of resolver.prefixes) {
    const match = new RegExp(`^${escapeRegex(normalize(prefix))}\\s*[:№#-]?\\s*(${value}(?:${sep}${value})*?)\\s*[.,;!]?$`, 'u').exec(input);
    if (match) return [...new Set(match[1].split(new RegExp(sep, 'u')).filter(Boolean))];
  }
  return [];
}
function isPrefixedReferenceLine(line: string, resolver: Resolver): boolean {
  return prefixedLineReferences(line, resolver).length > 0;
}
/** The keyword line names the prefix without a number of its own («Заказчик забрал заказ»). */
function hasBarePrefix(line: string, resolver: Resolver): boolean {
  const input = normalize(line);
  // The prefix as a word, not followed by a number («Заказ готов», «Заказчик забрал заказ»).
  return resolver.prefixes.some(prefix => new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalize(prefix))}(?![\\p{L}\\p{N}])(?![\\s:№#-]*\\d)`, 'u').test(input));
}

function lineRules(line: string, rules: Rule[]): Rule[] {
  return rules.filter(r => !r.exclusions.some(p => matches(line, p, 'phrase')) && r.keywords.some(k => matches(line, k, r.matchMode)));
}

export function planSignalGroups(text: string, source: string, config: SignalConfiguration): SignalPlan {
  const rules = matchRules(text, source, config);
  if (!rules.length || rules.some(r => r.matchMode === 'exact')) return { kind: 'legacy' };
  const resolverOf = (rule: Rule) => config.resolvers.find(r => r.code === rule.resolverCode)!;
  const resolvers = [...new Map(rules.map(r => [r.resolverCode, resolverOf(r)])).values()];
  const lines = text.split(/\r?\n/u).map(l => l.trim()).filter(Boolean);
  type Kind = { kind: 'K'; rules: Rule[] } | { kind: 'REF' } | { kind: 'OTHER' };
  const kinds: Kind[] = lines.map(line => {
    const fired = lineRules(line, rules);
    if (fired.length) return { kind: 'K', rules: fired };
    if (bareNumbers(line).length && resolvers.some(r => r.format === 'digits')) return { kind: 'REF' };
    if (resolvers.some(r => isPrefixedReferenceLine(line, r))) return { kind: 'REF' };
    return { kind: 'OTHER' };
  });
  if (!kinds.some(k => k.kind === 'K')) return { kind: 'legacy' };  // keyword only across lines
  if (lines.length === 1) {
    const many = rules.some(rule => extractReferenceList(lines[0], resolverOf(rule)).length > 1);
    if (!many) return { kind: 'legacy' };  // one line, one number — exactly as before
  }

  // Grouping: a keyword line opens a group; number-only lines right after it join it; number-only lines before a
  // keyword line without numbers of its own (a footer like «Готовы») join that line; any other line closes the group.
  const raw: Array<{ key: number; refs: number[]; rules: Rule[] }> = [];
  let current: (typeof raw)[number] | null = null;
  let pending: number[] = [];
  lines.forEach((line, i) => {
    const kind = kinds[i];
    if (kind.kind === 'K') {
      const ownNumbers = kind.rules.some(rule => extractReferenceList(line, resolverOf(rule)).length > 0);
      current = { key: i, refs: ownNumbers ? [] : pending, rules: kind.rules };
      raw.push(current);
      pending = [];
    } else if (kind.kind === 'REF') {
      if (current) current.refs.push(i); else pending.push(i);
    } else {
      current = null;
      pending = [];
    }
  });

  const groups: SignalGroup[] = [];
  let total = 0;
  raw.forEach((group, groupIndex) => {
    const keyLine = lines[group.key];
    const memberLines = [...group.refs.filter(i => i < group.key), group.key, ...group.refs.filter(i => i > group.key)];
    for (const signalCode of [...new Set(group.rules.map(r => r.signalCode))]) {
      const signalRules = group.rules.filter(r => r.signalCode === signalCode);
      const references: GroupReference[] = [];
      const used = new Set<number>([group.key]);
      const add = (line: number, resolverCode: string, reference: string) => {
        used.add(line);
        if (!references.some(r => r.resolverCode === resolverCode && r.reference === reference)) references.push({ resolverCode, reference });
      };
      for (const rule of signalRules) {
        const resolver = resolverOf(rule);
        const prefixed = group.refs.some(i => isPrefixedReferenceLine(lines[i], resolver));
        const bareAllowed = resolver.format === 'digits' && (hasBarePrefix(keyLine, resolver) || prefixed);
        for (const i of memberLines) {
          if (i === group.key) {
            for (const reference of extractReferenceList(lines[i], resolver)) add(i, resolver.code, reference);
            continue;
          }
          for (const reference of prefixedLineReferences(lines[i], resolver)) add(i, resolver.code, reference);
          if (bareAllowed) for (const reference of bareNumbers(lines[i])) add(i, resolver.code, reference);
        }
      }
      total += references.length;
      // A number line the group did not accept (bare numbers without a prefix) is not part of its fragment.
      const text = memberLines.filter(i => used.has(i)).map(i => lines[i]).join('\n');
      groups.push({ groupIndex, signalCode, ruleCodes: signalRules.map(r => r.code), text, references });
    }
  });
  return { kind: 'split', groups, tooMany: total > MAX_MESSAGE_REFERENCES };
}

/**
 * The fragment a user without message_signals.resolve may see: the references of the group that led to `orderId`
 * stay, every other reference of the group becomes «…».
 */
export function projectVisibleText(segmentText: string, references: Array<GroupReference & { orderId: string | null }>,
  orderId: string | null): string {
  // Matching runs on the normalized text (as extraction does: NFKC, «№», lower case). The text is normalized per
  // grapheme (a letter with its combining marks — «И\u0306» → «й»), and every normalized character remembers the
  // grapheme it came from, so «３０６２» or a decomposed letter is masked as well as its plain form. If the per-grapheme
  // form differs from the whole-text form extraction uses (context-dependent case or composition), nothing of the
  // fragment can be trusted to match: the whole fragment is hidden (code review r3 — symbols like «Ⓑ» fold to letters).
  const chars = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(segmentText)].map(g => g.segment);
  const fold = (value: string) => value.replace(/№/gu, '#').normalize('NFKC').toLocaleLowerCase('ru');
  let normalized = '';
  const origin: number[] = [];
  chars.forEach((ch, i) => {
    const piece = fold(ch);
    normalized += piece;
    for (let k = 0; k < piece.length; k++) origin.push(i);
  });
  if (normalized !== fold(segmentText)) return '…';
  const keep = new Set(references.filter(r => orderId !== null && r.orderId === orderId).map(r => r.reference));
  const kept: Array<[number, number]> = [], masked: Array<[number, number]> = [];
  const find = (reference: string, into: Array<[number, number]>) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(reference)}(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of normalized.matchAll(re)) into.push([m.index!, m.index! + m[0].length]);
  };
  for (const reference of keep) find(reference, kept);
  for (const { reference } of references) if (!keep.has(reference)) find(reference, masked);
  // Any other number of the fragment is hidden too: a number the group did not accept may still name another order.
  for (const m of normalized.matchAll(/\p{N}+/gu)) {
    const [start, end] = [m.index!, m.index! + m[0].length];
    if (!kept.some(([a, b]) => start >= a && end <= b)) masked.push([start, end]);
  }
  const hide = new Array<boolean>(chars.length).fill(false);
  for (const [start, end] of masked) {
    if (kept.some(([a, b]) => start >= a && end <= b)) continue;
    for (let k = start; k < end; k++) hide[origin[k]] = true;
  }
  let out = '';
  chars.forEach((ch, i) => { if (!hide[i]) out += ch; else if (!hide[i - 1]) out += '…'; });
  return out;
}
