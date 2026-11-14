# arianet-js

The official JavaScript/TypeScript client for the [Arianet](https://ariaservice.net) public API:
Cloud, classic and regional VPS, hosting, dedicated servers (bare metal), SMS, and your account
(API tokens, SSH keys, firewalls, balance, invoices).

- One method per API operation, generated from the published OpenAPI specs, with TypeScript types
  for every method and query.
- Personal API token auth, retries on `429` that honor `Retry-After`, safe retries of reads and
  idempotent writes after network errors and `502`/`503`/`504`.
- Typed errors carrying the API's stable error codes.
- No runtime dependencies; uses the built-in `fetch`. Node.js 20 or newer (ES module).

Documentation: <https://docs.ariaservice.net/sdk/js>

## Install

```bash
npm install arianet
```

Until the package is on npm, install a release straight from GitHub:

```bash
npm install https://github.com/ariaservice/arianet-js/releases/download/v0.1.0/arianet-0.1.0.tgz
```

## Quickstart

Create a personal API token at <https://cloud.ariaservice.net/users/api-tokens> and export it:

```bash
export ARIANET_TOKEN="paste-your-token-here"
```

```ts
import { Client } from "arianet";

const client = new Client(); // reads ARIANET_TOKEN

const page = await client.cloud.listServers({ per_page: 50, label_selector: "env=prod" });
for (const server of page.data) {
  console.log(server.id, server.name, server.status);
}
```

Keep the token on the server side: do not ship it to browsers.

## API groups

| Property              | API                                                               | Path prefix     |
|-----------------------|-------------------------------------------------------------------|-----------------|
| `client.core`         | Account, API tokens, classic VPS, SSH keys, firewalls, billing    | `/api/v1`       |
| `client.cloud`        | Cloud servers, volumes, networks, firewalls, IPs, load balancers  | `/cloud/v1`     |
| `client.regionalVps`  | Regional VPS                                                      | `/vps/v1`       |
| `client.hosting`      | Hosting accounts, DNS, mailboxes, databases                       | `/hosting/v1`   |
| `client.baremetal`    | Dedicated servers                                                 | `/baremetal/v1` |
| `client.sms`          | SMS messages, templates, lines, webhooks                          | `/sms/v1`       |

Method names are the camelCase `operationId` of each operation in the API reference
(<https://docs.ariaservice.net/api-reference>). Arguments come in this order: path parameters,
the JSON request body, the query object (typed as `<Group><Method>Query`, e.g.
`CloudListServersQuery`), then `RequestOptions` (`idempotencyKey`, `headers`, `region`,
`signal`). Every method resolves to the decoded JSON response.

```ts
const server = await client.cloud.createServer({
  name: "web-1",
  plan_id: 101,          // from client.cloud.listPlans()
  image: "ubuntu-24.04", // an image slug from client.cloud.listImages()
  datacenter: "ovh",     // a datacenter code from client.cloud.listDatacenters()
});
```

## Configuration

```ts
const client = new Client({
  token: process.env.MY_TOKEN,            // default: ARIANET_TOKEN
  baseUrl: "https://api.ariaservice.net", // default, or ARIANET_API_URL
  timeout: 60_000,                        // milliseconds per HTTP attempt
  maxRetries: 3,
  maxRetryWait: 60_000,                   // longest wait (ms) before one retry
  userAgent: "my-app/1.2",
});
```

The base URL must use `https` (plain `http` is accepted for `localhost` only). The client never
follows redirects, so the token is only ever sent to the API host.

## Retries and rate limits

- `429 Too Many Requests` is retried for every method, after the `Retry-After` header (or
  `RateLimit-Reset`). If the server asks for a longer wait than `maxRetryWait`, a
  `RateLimitError` is thrown at once with `retryAfter` (seconds) set.
- Network errors and `502`/`503`/`504` are retried only when repeating cannot do the work twice:
  `GET`/`HEAD` requests and requests with an `Idempotency-Key`.
- Operations that accept an `Idempotency-Key` (creating a server, an order, a hosting account...)
  get a generated key automatically, so they are retried safely. Pass `{ idempotencyKey }` to make
  retries across process restarts safe too.

## Errors

```ts
import { APIConnectionError, APIError, ErrorCode } from "arianet";

try {
  await client.core.createServer(order);
} catch (err) {
  if (err instanceof APIError) {
    if (err.code === ErrorCode.INSUFFICIENT_BALANCE) {
      // top up the wallet
    }
    console.error(err.status, err.code, err.message, err.requestId);
  } else if (err instanceof APIConnectionError) {
    // no answer: DNS, TLS, timeout
  } else {
    throw err;
  }
}
```

`err.code` is the API's stable machine code, always lower-cased (the core API's
`INSUFFICIENT_BALANCE` becomes `insufficient_balance`), so it can be compared with the generated
`ErrorCode` constants. Branch on the code, not on `message`. `err.reason` narrows the code on some
refusals (for example `identity_hold`).

Error classes by status: `BadRequestError` (400), `AuthenticationError` (401),
`PaymentRequiredError` (402), `PermissionDeniedError` (403), `NotFoundError` (404),
`ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429),
`InternalServerError` (5xx); all extend `APIError`, which extends `ArianetError`.

## Regions

Product APIs with regional installs take the `Arianet-Region` header:

```ts
const iran = client.regionalVps.withRegion("iran-1");
const servers = await iran.listServers();
// or per request:
await client.regionalVps.listServers({ region: "iran-1" });
```

## Endpoints not in this version

`client.request(method, path, { query, body, ...options })` calls any path with the same auth,
retries and error handling:

```ts
await client.request("GET", "/cloud/v1/new-endpoint", { query: { page: 2 } });
```

## How the code is generated

`specs/` holds the published OpenAPI documents and `codegen/services.json` lists where they come
from. `src/generated/` is produced by `codegen/generate.py` (Python standard library only):

```bash
python3 codegen/fetch_specs.py   # refresh specs/ (needs: pip install pyyaml)
python3 codegen/generate.py
python3 codegen/generate.py --check
```

The *Regenerate from specs* workflow does this every day and opens a pull request when the
published specs change. The rest of `src/` is hand-written and never touched by the generator.

## Development

```bash
npm ci
npm test
npm run typecheck
```

## License

MIT, see [LICENSE](LICENSE). Report security problems privately, see [SECURITY.md](SECURITY.md).
