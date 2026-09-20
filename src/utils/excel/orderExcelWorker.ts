import { buildOrderExcelBuffer, type GenerateOrderExcelParams } from './orderExcelBuilder';

interface OrderExcelWorkerRequest {
  requestId: string;
  params: GenerateOrderExcelParams;
}

// This module runs in a dedicated worker. Keep its small host contract local
// rather than adding WebWorker globals to the application's DOM compilation.
declare const self: {
  onmessage: ((event: MessageEvent<OrderExcelWorkerRequest>) => void) | null;
  postMessage: Worker['postMessage'];
};

interface SerializedWorkerError {
  name: string;
  message: string;
}

const serializeError = (error: unknown): SerializedWorkerError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
};

const toTransferableArrayBuffer = (value: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value;

  // A view may be backed by SharedArrayBuffer, which cannot be transferred.
  // Copy its exact byte range, including DataView and non-byte typed arrays.
  return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
};

self.onmessage = async (event: MessageEvent<OrderExcelWorkerRequest>) => {
  const { requestId, params } = event.data;

  try {
    const buffer = toTransferableArrayBuffer(await buildOrderExcelBuffer(params));
    self.postMessage({ requestId, ok: true, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: serializeError(error),
    });
  }
};
