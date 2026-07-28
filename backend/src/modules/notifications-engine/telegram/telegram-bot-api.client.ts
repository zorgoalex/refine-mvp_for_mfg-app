export type TelegramSendResult =
  | { kind: 'delivered'; messageId: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number; code: string; message: string }
  | { kind: 'permanent_failure'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string };

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

export interface TelegramBotApiClientOptions {
  apiBase: string;
  botToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class TelegramBotApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TelegramBotApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessage(destination: string, text: string): Promise<TelegramSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.apiBase.replace(/\/+$/, '')}/bot${this.options.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: destination,
            text: truncateTelegramText(text),
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      return {
        kind: 'unknown',
        code: 'TELEGRAM_TRANSPORT_UNCERTAIN',
        message: 'Telegram request outcome is unknown',
      };
    }

    const payload = await parseResponse(response);
    if (response.ok && payload?.ok === true && payload.result?.message_id !== undefined) {
      return { kind: 'delivered', messageId: String(payload.result.message_id) };
    }

    const description = safeTelegramDescription(payload?.description);
    if (
      response.status === 429 &&
      Number.isInteger(payload?.parameters?.retry_after) &&
      Number(payload?.parameters?.retry_after) > 0
    ) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Number(payload?.parameters?.retry_after),
        code: 'TELEGRAM_RATE_LIMITED',
        message: description,
      };
    }

    if ([400, 401, 403, 404].includes(response.status)) {
      return {
        kind: 'permanent_failure',
        code: `TELEGRAM_HTTP_${response.status}`,
        message: description,
      };
    }

    return {
      kind: 'unknown',
      code: response.status > 0 ? `TELEGRAM_HTTP_${response.status}` : 'TELEGRAM_INVALID_RESPONSE',
      message: 'Telegram request outcome is unknown',
    };
  }
}

function truncateTelegramText(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 4096 ? value : characters.slice(0, 4095).join('') + '…';
}

async function parseResponse(response: Response): Promise<TelegramApiResponse | null> {
  try {
    return (await response.json()) as TelegramApiResponse;
  } catch {
    return null;
  }
}

function safeTelegramDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'Telegram rejected the message';
  }
  return value.slice(0, 500);
}

export function formatTelegramNotification(title: string, message: string): string {
  const normalizedTitle = title.trim();
  const normalizedMessage = message.trim();
  if (!normalizedTitle) return normalizedMessage;
  if (!normalizedMessage) return normalizedTitle;
  return `${normalizedTitle}\n\n${normalizedMessage}`;
}
