import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { ONEC_COMMANDS_CHANNEL } from '../adapters/pg-onec-command-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';

type WaitReason = 'notify' | 'timeout' | 'aborted' | 'superseded';
type Owner = { token: symbol; wake: ((reason: 'notify' | 'superseded') => void) | null };

/**
 * Wakes waiting long polls when a command is queued for their agent. One
 * dedicated LISTEN connection per process (NOTIFY reaches every backend
 * instance); callers also poll on a short fallback timer, so a lost
 * notification only delays delivery. Waiting never holds a database
 * connection. One active long poll per agent (per process): a new lease
 * request claims ownership before its first query and supersedes the previous
 * one whether that one is waiting or about to lease.
 */
@Injectable()
export class OnecCommandWakeups implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecCommandWakeups.name);
  private readonly owners = new Map<string, Owner>();
  private client: PoolClient | null = null;
  private stopped = false;
  private generation = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  onModuleInit(): void {
    if (this.runtime.get().enabled) void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const owner of this.owners.values()) owner.wake?.('superseded');
    this.owners.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners('end');
      client.removeAllListeners('error');
      client.on('error', () => undefined);
      try {
        await client.query(`UNLISTEN ${ONEC_COMMANDS_CHANNEL}`);
      } catch {
        // connection may already be gone
      }
      client.release();
    }
  }

  /** Makes this lease request the agent's only active long poll; the previous one ends `superseded`. */
  claim(agentId: string): symbol {
    this.owners.get(agentId)?.wake?.('superseded');
    const token = Symbol(agentId);
    this.owners.set(agentId, { token, wake: null });
    return token;
  }

  isCurrent(agentId: string, token: symbol): boolean {
    return this.owners.get(agentId)?.token === token;
  }

  release(agentId: string, token: symbol): void {
    if (this.isCurrent(agentId, token)) this.owners.delete(agentId);
  }

  /**
   * Waits until a command is queued for the agent, the timeout elapses, the
   * caller aborts, or a newer long poll of the same agent supersedes this one.
   */
  wait(agentId: string, token: symbol, timeoutMs: number, signal: AbortSignal): Promise<WaitReason> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      const owner = this.owners.get(agentId);
      if (!owner || owner.token !== token) {
        resolve('superseded');
        return;
      }
      let settled = false;
      const finish = (reason: WaitReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (owner.wake === wake) owner.wake = null;
        resolve(reason);
      };
      const wake = (reason: 'notify' | 'superseded') => finish(reason);
      const onAbort = () => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
      signal.addEventListener('abort', onAbort);
      owner.wake = wake;
    });
  }

  /** In-process wake (used right after an enqueue commit and by tests). */
  wake(agentId: string): void {
    this.owners.get(agentId)?.wake?.('notify');
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const generation = ++this.generation;
    let client: PoolClient | null = null;
    let released = false;
    const drop = (error: unknown) => {
      if (released || !client) return;
      released = true;
      if (this.client === client) this.client = null;
      client.release(true);
      if (generation === this.generation) this.scheduleReconnect(error);
    };
    try {
      client = await this.database.connectDedicated('1C command LISTEN connect');
      if (this.stopped || generation !== this.generation) {
        released = true;
        client.release();
        return;
      }
      client.on('notification', (message) => {
        if (message.channel === ONEC_COMMANDS_CHANNEL && message.payload) this.wake(message.payload);
      });
      client.once('error', drop);
      client.once('end', () => drop(new Error('LISTEN connection ended')));
      await client.query(`LISTEN ${ONEC_COMMANDS_CHANNEL}`);
      if (released) return;
      if (this.stopped) {
        released = true;
        client.release();
        return;
      }
      this.client = client;
    } catch (error) {
      // Never leak the pooled connection: a failed LISTEN releases (destroys) it before retrying.
      if (client) drop(error);
      else this.scheduleReconnect(error);
    }
  }

  private scheduleReconnect(error: unknown): void {
    if (this.stopped || this.reconnectTimer) return;
    this.logger.warn(`1C command LISTEN unavailable, retrying: ${error instanceof Error ? error.message : String(error)}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 5000);
    this.reconnectTimer.unref();
  }
}
