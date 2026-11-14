/** Base class of every error this package throws. */
export class ArianetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request got no answer: DNS, TLS, timeout or a dropped connection. */
export class APIConnectionError extends ArianetError {}

export interface APIErrorInit {
  status: number;
  code: string;
  message: string;
  reason?: string;
  retryAfter?: number;
  requestId?: string;
  body?: unknown;
}

/**
 * The API answered with an error. Branch on `code` (the API's stable machine code,
 * lower-cased; compare it with `ErrorCode`), not on `message`.
 */
export class APIError extends ArianetError {
  /** HTTP status. */
  readonly status: number;
  /** The API's stable machine code, lower-cased. */
  readonly code: string;
  /** Narrows `code` on some refusals (e.g. "identity_hold"). */
  readonly reason?: string;
  /** Seconds the server asked to wait (Retry-After), if it did. */
  readonly retryAfter?: number;
  /** Request identifier for support, when the server sent one. */
  readonly requestId?: string;
  /** The decoded response body, or its text when it was not JSON. */
  readonly body?: unknown;

  constructor(init: APIErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

/** HTTP 400. */
export class BadRequestError extends APIError {}
/** HTTP 401: the token is missing, expired or revoked. */
export class AuthenticationError extends APIError {}
/** HTTP 402: usually `insufficient_balance`. */
export class PaymentRequiredError extends APIError {}
/** HTTP 403: missing scope, IP not allowed, identity check needed... */
export class PermissionDeniedError extends APIError {}
/** HTTP 404. */
export class NotFoundError extends APIError {}
/** HTTP 409. */
export class ConflictError extends APIError {}
/** HTTP 422: validation failed. */
export class UnprocessableEntityError extends APIError {}
/** HTTP 429 that was still refused after the retries. */
export class RateLimitError extends APIError {}
/** HTTP 5xx. */
export class InternalServerError extends APIError {}

const BY_STATUS: Record<number, typeof APIError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

const DEFAULT_CODES: Record<number, string> = { 401: "unauthorized", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

/** Retry-After (seconds or an HTTP date), or RateLimit-Reset on a 429, in seconds. */
export function parseRetryAfter(headers: Headers, status: number): number | undefined {
  const value = (headers.get("retry-after") ?? "").trim();
  if (value) {
    if (/^\d+$/.test(value)) return Number(value);
    const when = Date.parse(value);
    if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
  }
  if (status === 429) {
    const reset = (headers.get("ratelimit-reset") ?? "").trim();
    if (/^\d+$/.test(reset) && Number(reset) > 0) return Number(reset);
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * The APIError a response stands for, or undefined. Reads the three error shapes:
 * `{"success": false, "error": {"code", "message"}}` (core API),
 * `{"error": "message", "code", "reason"}` (cloud API) and `{"code", "message"}` (product APIs).
 */
export function errorFromResponse(status: number, headers: Headers, text: string): APIError | undefined {
  let data: unknown = undefined;
  let decoded = true;
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
      decoded = false;
    }
  }
  const obj = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const failed = status >= 300 || obj.success === false;
  if (!failed) return undefined;

  let code = str(obj.code);
  let message = str(obj.message);
  let reason = str(obj.reason);
  const err = obj.error;
  if (typeof err === "string") {
    message = err || message;
  } else if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    code = str(e.code) ?? code;
    message = str(e.message) ?? message;
    reason = str(e.reason) ?? reason;
  }
  code ??= decoded ? (DEFAULT_CODES[status] ?? "request_failed") : "unexpected_response";
  message ??= `request failed with HTTP ${status}`;

  const Cls = BY_STATUS[status] ?? (status >= 500 ? InternalServerError : APIError);
  return new Cls({
    status,
    code: code.toLowerCase(),
    message,
    reason,
    retryAfter: parseRetryAfter(headers, status),
    requestId: headers.get("x-request-id") ?? headers.get("request-id") ?? undefined,
    body: data,
  });
}
