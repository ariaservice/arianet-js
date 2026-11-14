import { APIConnectionError, APIError, ArianetError, errorFromResponse } from "./errors.js";
import { Services } from "./generated/clientServices.js";
import type { RequestOptions, Transport } from "./service.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.ariaservice.net";
export const REGION_HEADER = "Arianet-Region";

export interface ClientOptions {
  /** Personal API token; ARIANET_TOKEN is read when omitted. */
  token?: string;
  /** API root, default https://api.ariaservice.net or ARIANET_API_URL. Must be https (http only for localhost). */
  baseUrl?: string;
  /** Milliseconds per HTTP attempt. Default 60000. */
  timeout?: number;
  /** Repeats after a 429, or after a network error or 502/503/504 when the request is safe to repeat. Default 3. */
  maxRetries?: number;
  /** Longest wait in milliseconds before one retry; a 429 asking for longer throws RateLimitError at once. Default 60000. */
  maxRetryWait?: number;
  /** Product token appended to the User-Agent header (Node.js only; browsers ignore it). */
  userAgent?: string;
  /** fetch implementation, default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Replaces the wait between retries (for tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Options of {@link Client.request}. */
export interface RawRequestOptions extends RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

function checkBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArianetError(`invalid base URL "${raw}"`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && (host === "localhost" || host === "::1" || /^127\./.test(host))) return;
  throw new ArianetError(`base URL "${raw}" must use https`);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoff(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base + Math.random() * (base / 4);
}

function uuid4(): string {
  return globalThis.crypto.randomUUID();
}

class HttpTransport implements Transport {
  readonly token: string;
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly maxRetryWait: number;
  readonly userAgent: string;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.token = opts.token ?? env("ARIANET_TOKEN") ?? "";
    this.baseUrl = (opts.baseUrl ?? env("ARIANET_API_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    checkBaseUrl(this.baseUrl);
    this.timeout = opts.timeout ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryWait = opts.maxRetryWait ?? 60_000;
    this.userAgent = `arianet-js/${VERSION}${opts.userAgent ? ` ${opts.userAgent}` : ""}`;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new ArianetError("no fetch implementation: use Node.js 20+ or pass options.fetch");
    this.fetchImpl = f.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async send(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: RequestOptions | undefined,
    idempotent: boolean,
  ): Promise<any> {
    method = method.toUpperCase();
    let idempotencyKey = options?.idempotencyKey;
    if (idempotent && !idempotencyKey && method !== "GET") idempotencyKey = uuid4();

    let url = this.baseUrl + path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;

    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    headers["Accept"] = "application/json";
    headers["User-Agent"] = this.userAgent;
    let payload: string | undefined;
    if (body !== undefined && body !== null) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (options?.region) headers[REGION_HEADER] = options.region;

    // A network error or a 5xx is only repeated when that cannot do the work twice.
    const safe = method === "GET" || method === "HEAD" || Boolean(idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(method, url, headers, payload, options?.signal);
      } catch (err) {
        if (options?.signal?.aborted) throw err;
        const wait = this.retryWait(err, attempt, safe);
        if (attempt >= this.maxRetries || wait === undefined) throw err;
        await this.sleep(wait, options?.signal);
      }
    }
  }

  private async attempt(method: string, url: string, headers: Record<string, string>, payload: string | undefined, signal?: AbortSignal): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new APIConnectionError(`request timed out after ${this.timeout} ms`)), this.timeout);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, { method, headers, body: payload, redirect: "manual", signal: controller.signal });
      text = await response.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof APIConnectionError) throw err;
      const reason = controller.signal.aborted ? controller.signal.reason : undefined;
      if (reason instanceof APIConnectionError) throw reason;
      throw new APIConnectionError(`request failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    // With redirect: "manual" a browser reports a redirect as an opaque status 0.
    const status = response.status === 0 ? 302 : response.status;
    const error = errorFromResponse(status, response.headers, text);
    if (error) throw error;
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private retryWait(err: unknown, attempt: number, safe: boolean): number | undefined {
    if (err instanceof APIError) {
      if (err.status === 429 || (safe && [502, 503, 504].includes(err.status))) {
        const wait = err.retryAfter !== undefined ? err.retryAfter * 1000 : backoff(attempt);
        return wait <= this.maxRetryWait ? wait : undefined;
      }
      return undefined;
    }
    if (err instanceof APIConnectionError) return safe ? backoff(attempt) : undefined;
    return undefined;
  }
}

/**
 * Client for the Arianet public API.
 *
 * ```ts
 * const client = new Client(); // reads ARIANET_TOKEN
 * const page = await client.cloud.listServers({ per_page: 50 });
 * ```
 */
export class Client extends Services {
  readonly #transport: HttpTransport;

  constructor(options: ClientOptions = {}) {
    const transport = new HttpTransport(options);
    super(transport);
    this.#transport = transport;
  }

  /**
   * Calls any API path (including its prefix, e.g. "/cloud/v1/servers"). Generated
   * methods use this too; call it for endpoints this version does not have yet.
   * Resolves to the decoded JSON body.
   */
  request(method: string, path: string, options: RawRequestOptions = {}): Promise<any> {
    const { query, body, ...rest } = options;
    return this.#transport.send(method, path, query, body, rest, false);
  }
}
