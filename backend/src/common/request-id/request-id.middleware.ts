import { DEFAULT_REQUEST_ID_HEADER, getOrCreateRequestId } from './request-id';

interface RequestLike {
  headers: Record<string, unknown>;
  requestId?: string;
}

interface ResponseLike {
  setHeader(name: string, value: string): void;
}

type NextFunctionLike = () => void;

export function requestIdMiddleware(
  req: RequestLike,
  res: ResponseLike,
  next: NextFunctionLike,
): void {
  createRequestIdMiddleware()(req, res, next);
}

export function createRequestIdMiddleware(headerName = DEFAULT_REQUEST_ID_HEADER) {
  const normalizedHeaderName = headerName.toLowerCase();

  return (req: RequestLike, res: ResponseLike, next: NextFunctionLike): void => {
    const requestId = getOrCreateRequestId(req.headers[normalizedHeaderName]);

    req.requestId = requestId;
    res.setHeader(normalizedHeaderName, requestId);
    next();
  };
}
