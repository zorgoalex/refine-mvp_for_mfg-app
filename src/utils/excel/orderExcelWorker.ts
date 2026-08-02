import { buildOrderExcelBuffer, type GenerateOrderExcelParams } from './orderExcelBuilder';

interface OrderExcelWorkerRequest {
  requestId: string;
  params: GenerateOrderExcelParams;
}

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

  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
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
