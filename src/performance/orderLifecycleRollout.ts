import type { OrderLifecycleRuntimeConfig } from '../config/runtimeConfig';

export type OrderLifecycleCohort = 'disabled' | 'control' | 'treatment';

export async function assignOrderLifecycleCohort(
  config: OrderLifecycleRuntimeConfig | null | undefined,
  rolloutSubjectId: string | null | undefined,
  digest: (value: string) => Promise<Uint8Array> = sha256,
): Promise<OrderLifecycleCohort> {
  if (!isUsableOrderLifecycleConfig(config) || !rolloutSubjectId) return 'disabled';

  const bytes = await digest(`orderLifecycleV2:${config.allocationSalt}:${rolloutSubjectId}`);
  if (bytes.length < 4) return 'disabled';
  const value = (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
  const bucket = Math.floor((value / 0x1_0000_0000) * 100);
  return bucket < config.percent ? 'treatment' : 'control';
}

export function isUsableOrderLifecycleConfig(
  config: OrderLifecycleRuntimeConfig | null | undefined,
): config is OrderLifecycleRuntimeConfig {
  return Boolean(
    config?.enabled &&
    Number.isInteger(config.percent) &&
    config.percent >= 0 &&
    config.percent <= 100 &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(config.allocationSalt) &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(config.configVersion),
  );
}

async function sha256(value: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) return new Uint8Array();
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
