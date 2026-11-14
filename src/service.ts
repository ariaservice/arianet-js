/** Options every API method accepts as its last argument. */
export interface RequestOptions {
  /** Idempotency-Key header; generated for operations that support it when omitted. */
  idempotencyKey?: string;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
  /** Regional install of a product API (the Arianet-Region header). */
  region?: string;
  /** Aborts the request (and any wait before a retry). */
  signal?: AbortSignal;
}

/** What the generated services need from the client. */
export interface Transport {
  send(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: RequestOptions | undefined,
    idempotent: boolean,
  ): Promise<any>;
}

export function pathSegment(value: number | string): string {
  return encodeURIComponent(String(value));
}

/** Base class of the generated API groups. */
export abstract class Service {
  protected abstract readonly prefix: string;

  constructor(
    protected readonly transport: Transport,
    protected readonly region?: string,
  ) {}

  /** A copy of this API group whose requests go to `region` (the Arianet-Region header). */
  withRegion(region: string | undefined): this {
    const Ctor = this.constructor as new (transport: Transport, region?: string) => this;
    return new Ctor(this.transport, region);
  }

  protected send(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
    options: RequestOptions | undefined,
    idempotent: boolean,
  ): Promise<any> {
    const opts = this.region !== undefined && options?.region === undefined ? { ...options, region: this.region } : options;
    return this.transport.send(method, path, query, body, opts, idempotent);
  }
}
