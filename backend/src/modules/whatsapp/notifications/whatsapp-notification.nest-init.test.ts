import 'reflect-metadata';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

/**
 * The guarantee the delivery epoch relies on (plan R3/R3.1), checked against the installed Nest: an async
 * onModuleInit of an imported module is awaited before the importing module's providers are initialised —
 * as the 1C module (consumer) imports WhatsAppModule (channel). A failing epoch start is swallowed by the
 * worker (ensureEpoch never throws), so the consumer still starts.
 */
const order: string[] = [];

class ChannelWorker implements OnModuleInit {
  static fail = false;
  async onModuleInit() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push(ChannelWorker.fail ? 'channel-epoch-failed' : 'channel-epoch');
  }
}

class ChannelPort {}

class ChannelModule {}

// The order follows the module imports (the consumer imports the channel module), not constructor injection.
class ConsumerMonitor implements OnModuleInit {
  onModuleInit() {
    order.push('consumer-monitor');
  }
}

class ConsumerModule {}

class AppModule {}

// Decorators applied as functions: the backend test transform does not accept decorator syntax.
Injectable()(ChannelWorker);
Injectable()(ChannelPort);
Injectable()(ConsumerMonitor);
Module({ providers: [ChannelWorker, ChannelPort], exports: [ChannelPort] })(ChannelModule);
Module({ imports: [ChannelModule], providers: [ConsumerMonitor] })(ConsumerModule);
Module({ imports: [ConsumerModule, ChannelModule] })(AppModule);

describe('Nest initialisation order of the channel and its consumer', () => {
  it('the channel epoch starts before the consumer, also when it failed (and the consumer still starts)', async () => {
    for (const fail of [false, true]) {
      order.length = 0;
      ChannelWorker.fail = fail;
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
      await app.close();
      expect(order).toEqual([fail ? 'channel-epoch-failed' : 'channel-epoch', 'consumer-monitor']);
    }
  });
});
