import type { CadGroup, CadSourceSnapshot, CadVariant } from '@shared/cad-workspace';

export interface CadDraft { groups: CadGroup[]; sources: CadSourceSnapshot[] }
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export interface SaveState { base: CadVariant; draft: CadDraft; status: SaveStatus; error: unknown; incomplete: boolean }
type Transport = (base: CadVariant, groups: CadGroup[], sourceIds: string[], key: string) => Promise<CadVariant>;
const equal = (a: CadDraft, b: CadDraft) => JSON.stringify(a) === JSON.stringify(b);
const draftOf = (v: CadVariant): CadDraft => ({ groups: v.groups, sources: v.sources });

/** One in flight, latest pending; failed bodies retain their idempotency key. */
export class CadAutosave {
  private state: SaveState;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<CadVariant>;
  private request?: { base: CadVariant; draft: CadDraft; key: string };
  private rejected = false;
  constructor(base: CadVariant, private transport: Transport, private key: () => string = () => crypto.randomUUID()) {
    this.state = { base, draft: draftOf(base), status: 'saved', error: null, incomplete: false };
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<SaveState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  edit(draft: CadDraft, immediate = false) {
    if (this.state.base.kind === 'original') return;
    const corrected = this.state.status === 'error' && this.rejected;
    this.update({ draft: structuredClone(draft), status: !corrected && ['conflict', 'error', 'saving'].includes(this.state.status) ? this.state.status : 'dirty', error: corrected ? null : this.state.error });
    clearTimeout(this.timer);
    if (!['conflict', 'error'].includes(this.state.status) && !this.state.incomplete) {
      this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, immediate ? 0 : 700);
    }
  }
  setIncomplete(incomplete: boolean) {
    if (incomplete === this.state.incomplete) return;
    this.update({ incomplete }); clearTimeout(this.timer);
    if (!incomplete && this.state.status === 'dirty') this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 700);
  }
  accept(base: CadVariant) {
    if (this.state.status === 'saved' && !this.state.incomplete && !this.flight && base.version > this.state.base.version) this.update({ base, draft: draftOf(base) });
  }
  async flush(): Promise<CadVariant> {
    clearTimeout(this.timer);
    if (this.state.incomplete) throw new Error('Завершите ввод параметров');
    if (this.state.status === 'conflict') throw new Error('Выберите, как разрешить конфликт версий');
    if (this.flight) { await this.flight; return this.flush(); }
    if (!this.request && equal(this.state.draft, draftOf(this.state.base))) { this.update({ status: 'saved' }); return this.state.base; }
    this.request ??= { base: this.state.base, draft: structuredClone(this.state.draft), key: this.key() };
    this.rejected = false;
    const request = this.request;
    this.update({ status: 'saving', error: null });
    const operation = this.transport(request.base, request.draft.groups, request.draft.sources.map(s => s.id), request.key);
    this.flight = operation;
    try {
      const base = await operation;
      this.request = undefined;
      const current = equal(this.state.draft, request.draft);
      this.update({ base, draft: current ? draftOf(base) : this.state.draft, status: current ? 'saved' : 'dirty', error: null });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      // A known rejection did not commit. Corrected input gets a new command;
      // unknown/network failures retain the exact body/key to reconcile a lost ACK.
      this.rejected = [400, 403, 404, 422].includes(status);
      if (this.rejected) this.request = undefined;
      this.update({ status: ['CAD_STALE_VERSION', 'CAD_CONCURRENT_CHANGE'].includes(code) ? 'conflict' : 'error', error });
      throw error;
    } finally { this.flight = undefined; }
    if (this.state.status === 'dirty' && !this.state.incomplete) return this.flush();
    return this.state.base;
  }
  /** Explicit discard only, never called by an automatic workspace refetch. */
  reset(base: CadVariant) {
    if (this.flight) throw new Error('Дождитесь завершения сохранения');
    clearTimeout(this.timer); this.request = undefined; this.rejected = false;
    this.update({ base, draft: draftOf(base), status: 'saved', error: null, incomplete: false });
  }
  dispose() { clearTimeout(this.timer); this.listeners.clear(); }
}
