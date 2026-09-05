import { useEffect, useState } from 'react';
import { cutApi } from '../api/cutApi';

type NumberCheck = { status: 'checking' | 'available' | 'error'; message: string; suggestions?: number[] };

/** Only selected rows participate; stale responses never validate a changed number. */
export function useCutJobNumberChecks(
  selectedIds: string[],
  numbers: Record<string, number | null>,
  enabled: boolean,
): { checks: Record<string, NumberCheck>; ready: boolean; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const entries = selectedIds.filter((id) => numbers[id] != null)
    .map((id) => [id, numbers[id]!] as const).sort(([a], [b]) => a.localeCompare(b));
  const signature = JSON.stringify({ entries, attempt });
  const [remote, setRemote] = useState<{ signature: string; checks: Record<string, NumberCheck> } | null>(null);
  const errors: Record<string, NumberCheck> = {};
  for (const [id, number] of entries) {
    if (!Number.isSafeInteger(number) || number < 1) {
      errors[id] = { status: 'error', message: 'Введите положительный целый номер' };
    } else if (entries.some(([otherId, other]) => otherId !== id && other === number)) {
      errors[id] = { status: 'error', message: 'Номер повторяется в выбранных комплектах' };
    }
  }
  const hasErrors = Object.keys(errors).length > 0;

  useEffect(() => {
    if (!enabled || hasErrors) return;
    let cancelled = false;
    const requested: Array<[string, number]> = JSON.parse(signature).entries;
    const timer = window.setTimeout(() => {
      void (async () => {
        const checks: Record<string, NumberCheck> = {};
        // Bound concurrent reads even for large imported selections.
        for (let offset = 0; offset < requested.length && !cancelled; offset += 4) {
          await Promise.all(requested.slice(offset, offset + 4).map(async ([id, number]) => {
            try {
              const jobs = await cutApi.list({ jobNumber: String(number), includeArchived: false });
              checks[id] = jobs.some((job) => job.status !== 'archived' && job.displayNumber === String(number))
                ? { status: 'error', message: `Задание №${number} уже существует` }
                : { status: 'available', message: 'Номер свободен' };
              if (checks[id].status === 'error') {
                const suggestions: number[] = [];
                for (let step = 1; step <= 10 && suggestions.length < 3 && !cancelled; step += 1) {
                  const candidate = number + step;
                  if (!Number.isSafeInteger(candidate) || requested.some(([, value]) => value === candidate)) continue;
                  try {
                    const matches = await cutApi.list({ jobNumber: String(candidate), includeArchived: false });
                    if (!matches.some((job) => job.status !== 'archived' && job.displayNumber === String(candidate))) suggestions.push(candidate);
                  } catch { break; } // Suggestions are optional; retain the known conflict.
                }
                checks[id].suggestions = suggestions;
              }
            } catch {
              checks[id] = { status: 'error', message: 'Не удалось проверить номер. Повторите проверку' };
            }
          }));
        }
        if (!cancelled) setRemote({ signature, checks });
      })();
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [enabled, hasErrors, signature]);

  const checks = Object.fromEntries(entries.map(([id]) => [
    id,
    errors[id] ?? (remote?.signature === signature ? remote.checks[id] : undefined)
      ?? { status: 'checking' as const, message: 'Проверка номера…' },
  ]));
  return { checks, ready: entries.every(([id]) => checks[id].status === 'available'), retry: () => setAttempt((value) => value + 1) };
}
