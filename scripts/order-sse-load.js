#!/usr/bin/env node

const {
  assertIsolatedLoadAllowed,
  assertIsolatedTargetResolution,
  consumeSseCommentChunk,
  parseOrderSseLoadArgs,
  readLoadCredentials,
} = require('./order-sse-load-lib.js');
const { createEvidenceLogger, safeErrorMessage } = require('./order-sse-rollout-lib.js');

async function main() {
  const config = parseOrderSseLoadArgs(process.argv.slice(2));
  if (config.help) return printUsage();
  assertIsolatedLoadAllowed(config);
  await assertIsolatedTargetResolution(config);
  const credentials = readLoadCredentials(config);
  const evidence = createEvidenceLogger(config.logRoot, 'isolated-load');
  const abortController = new AbortController();
  const sigint = () => abortController.abort(new Error('SIGINT'));
  const sigterm = () => abortController.abort(new Error('SIGTERM'));
  const activeConnections = new Set();
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  let summary;
  try {
    evidence.log('load_started', {
      targetEnv: config.targetEnv,
      backendOrigin: new URL(config.backendUrl).origin,
      clients: config.clients,
      credentialCount: credentials.length,
      connectionsPerUser: config.connectionsPerUser,
      reconnectRounds: config.reconnectRounds,
      roundSeconds: config.roundSeconds,
    });
    const identities = await loginAll(config, credentials, abortController.signal);
    let openedTotal = 0;
    let unexpectedDisconnects = 0;
    let heartbeatCount = 0;
    for (let round = 1; round <= config.reconnectRounds; round += 1) {
      const connections = await openRound(config, identities, abortController.signal, activeConnections);
      openedTotal += connections.length;
      evidence.log('load_round_opened', { round, opened: connections.length });
      await delay(config.roundSeconds * 1000, abortController.signal);
      for (const connection of connections) connection.controller.abort();
      const results = await Promise.allSettled(connections.map((connection) => connection.reader));
      for (const connection of connections) activeConnections.delete(connection);
      unexpectedDisconnects += results.filter((result) => result.status === 'rejected' && !abortController.signal.aborted).length;
      const roundHeartbeatCount = connections.reduce((sum, connection) => sum + connection.metrics.heartbeats, 0);
      heartbeatCount += roundHeartbeatCount;
      evidence.log('load_round_closed', { round, unexpectedDisconnects, heartbeatCount });
      if (unexpectedDisconnects > 0) throw new Error('Unexpected SSE disconnect during isolated load round');
      if (roundHeartbeatCount < connections.length) {
        throw new Error('One or more isolated SSE connections received no heartbeat');
      }
    }
    summary = {
      status: 'isolated_load_passed',
      clients: config.clients,
      reconnectRounds: config.reconnectRounds,
      openedTotal,
      unexpectedDisconnects,
      heartbeatCount,
    };
    evidence.log('load_completed', summary);
  } catch (error) {
    if (!abortController.signal.aborted) abortController.abort(error);
    summary = { status: 'isolated_load_failed', error: safeErrorMessage(error) };
    evidence.log('load_failed', summary);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
    if (!abortController.signal.aborted) abortController.abort(new Error('load cleanup'));
    const cleanup = await closeConnections(activeConnections, 5000);
    if (cleanup.timedOut || cleanup.remaining > 0) {
      summary = {
        ...(summary || {}),
        status: 'isolated_load_failed',
        cleanup,
      };
      process.exitCode = 1;
    }
    evidence.log(cleanup.timedOut ? 'cleanup_failed' : 'cleanup_verified', cleanup);
    try {
      evidence.validate();
      evidence.writeSummary(summary);
    } finally {
      evidence.close();
    }
  }
}

async function loginAll(config, credentials, signal) {
  return Promise.all(credentials.map(async (credential) => {
    const { response, consumed: body } = await fetchBounded(`${config.backendUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: credential.username, password: credential.password }),
    }, signal, 10000, async (loginResponse) => (
      loginResponse.ok ? loginResponse.json() : loginResponse.arrayBuffer().then(() => null)
    ));
    if (!response.ok) throw new Error(`Isolated login failed: HTTP ${response.status}`);
    if (!body.accessToken) throw new Error('Isolated login returned no access token');
    return { accessToken: body.accessToken, orderId: credential.orderId };
  }));
}

async function openRound(config, identities, parentSignal, activeConnections) {
  const assignments = [];
  for (const identity of identities) {
    for (let index = 0; index < config.connectionsPerUser && assignments.length < config.clients; index += 1) {
      assignments.push(identity);
    }
  }
  const connections = [];
  for (let offset = 0; offset < assignments.length; offset += config.openBatchSize) {
    const batch = assignments.slice(offset, offset + config.openBatchSize);
    const opened = await Promise.all(batch.map(async (identity) => {
      const connection = await openConnection(config, identity, parentSignal);
      activeConnections.add(connection);
      return connection;
    }));
    connections.push(...opened);
    if (connections.length < assignments.length) await delay(config.openBatchDelayMs, parentSignal);
  }
  return connections;
}

async function openConnection(config, identity, parentSignal) {
  const headers = { authorization: `Bearer ${identity.accessToken}` };
  const { response: snapshot } = await fetchBounded(`${config.backendUrl}/orders/${identity.orderId}/detail-live-state`, {
    headers: { ...headers, accept: 'application/json' },
  }, parentSignal, 10000, (snapshotResponse) => snapshotResponse.arrayBuffer());
  if (snapshot.status !== 200 || snapshot.headers.get('x-erp-realtime-enabled') !== 'true') {
    throw new Error(`Isolated snapshot failed: HTTP ${snapshot.status}`);
  }
  const cursor = snapshot.headers.get('x-erp-stream-cursor');
  if (!cursor) throw new Error('Isolated snapshot returned no cursor');

  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  let response;
  const handshakeTimeout = setTimeout(
    () => controller.abort(new Error('SSE handshake timeout after 15000ms')),
    15000,
  );
  handshakeTimeout.unref?.();
  try {
    response = await fetch(`${config.backendUrl}/orders/${identity.orderId}/live-events`, {
      headers: { ...headers, accept: 'text/event-stream', 'last-event-id': cursor },
      signal: controller.signal,
    });
    if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) {
      throw new Error(`Isolated SSE open failed: HTTP ${response.status}`);
    }
  } catch (error) {
    controller.abort();
    parentSignal.removeEventListener('abort', abort);
    if (response?.body) await response.body.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(handshakeTimeout);
  }
  const metrics = { heartbeats: 0 };
  const reader = consumeStream(response.body, controller.signal, metrics)
    .finally(() => parentSignal.removeEventListener('abort', abort));
  reader.catch(() => undefined);
  return { controller, reader, metrics };
}

async function fetchBounded(url, init, parentSignal, timeoutMs, consume) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timeout.unref?.();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const consumed = await consume(response);
    return { response, consumed };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abort);
  }
}

async function consumeStream(body, signal, metrics) {
  if (!body) throw new Error('Isolated SSE response body is missing');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let remainder = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done && !signal.aborted) throw new Error('Isolated SSE stream ended unexpectedly');
      if (value) {
        const parsed = consumeSseCommentChunk(remainder, decoder.decode(value, { stream: true }));
        remainder = parsed.remainder;
        metrics.heartbeats += parsed.heartbeats;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function closeConnections(activeConnections, timeoutMs) {
  const pending = [...activeConnections];
  for (const connection of pending) connection.controller.abort();
  let timedOut = false;
  if (pending.length > 0) {
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled(pending.map((connection) => connection.reader)),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!timedOut) {
    for (const connection of pending) activeConnections.delete(connection);
  }
  return {
    aborted: true,
    tracked: pending.length,
    remaining: activeConnections.size,
    timedOut,
  };
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const abort = () => {
      clearTimeout(timer);
      finish(() => reject(new Error('Isolated load aborted')));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function printUsage() {
  process.stdout.write([
    'Isolated-only Order SSE connection load generator.',
    '',
    'Required: --target-env isolated-load --backend-url <url> --credential-file <0600-json> --log-root <dir>',
    'Approval: ORDER_SSE_LOAD_APPROVE_ISOLATED=true',
    'Defaults: --clients 200 --connections-per-user 20 --reconnect-rounds 3 --round-seconds 600',
    'Known ERP shared/stage/production hosts and this runner are hard-denied.',
  ].join('\n') + '\n');
}

main().catch((error) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
