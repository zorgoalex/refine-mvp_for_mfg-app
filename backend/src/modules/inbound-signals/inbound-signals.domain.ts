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
