import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import * as arianet from "../dist/index.js";

const { Client, ErrorCode } = arianet;

/** Answers each request with the next scripted reply and records it. */
async function mockServer(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = replies.shift();
      if (!reply) {
        res.writeHead(500).end();
        return;
      }
      if (reply.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers ?? {}) });
      res.end(reply.body ?? "{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function setup(replies, options = {}) {
  const mock = await mockServer(replies);
  const waits = [];
  const client = new Client({
    token: "tok_123",
    baseUrl: mock.url,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { client, seen: mock.seen, waits, url: mock.url };
}

describe("Client", () => {
  it("sends the token, user agent, path and query", async () => {
    const { client, seen } = await setup([{ status: 200, body: '{"data":[{"id":1}],"meta":{}}' }]);
    const result = await client.cloud.listServers({ page: 2, label_selector: "env=prod" });
    assert.equal(seen[0].headers.authorization, "Bearer tok_123");
    assert.match(seen[0].headers["user-agent"], /^arianet-js\//);
    assert.equal(seen[0].method, "GET");
    assert.equal(seen[0].url, "/cloud/v1/servers?page=2&label_selector=env%3Dprod");
    assert.equal(result.data[0].id, 1);
  });

  it("reads the token from ARIANET_TOKEN", async () => {
    const mock = await mockServer([{ status: 200, body: '{"success":true,"data":{}}' }]);
    process.env.ARIANET_TOKEN = "env_tok";
    try {
      await new Client({ baseUrl: mock.url }).core.getMe();
    } finally {
      delete process.env.ARIANET_TOKEN;
    }
    assert.equal(mock.seen[0].headers.authorization, "Bearer env_tok");
  });

  it("escapes path parameters", async () => {
    const { client, seen } = await setup([{ status: 200 }]);
    await client.core.getInvoice("INV/1 2");
    assert.equal(seen[0].url, "/api/v1/invoices/INV%2F1%202");
  });

  it("retries a 429 after Retry-After", async () => {
    const { client, seen, waits } = await setup([
      { status: 429, body: '{"code":"rate_limited","message":"slow down"}', headers: { "Retry-After": "7" } },
      { status: 200 },
    ]);
    await client.sms.sendMessage({ to: ["0912"] });
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, [7000]);
    assert.equal(seen[0].body, seen[1].body);
  });

  it("uses RateLimit-Reset on a 429 without Retry-After", async () => {
    const { client, waits } = await setup([{ status: 429, headers: { "RateLimit-Reset": "3" } }, { status: 200 }]);
    await client.cloud.listDatacenters();
    assert.deepEqual(waits, [3000]);
  });

  it("throws at once when Retry-After is longer than maxRetryWait", async () => {
    const { client, seen, waits } = await setup([
      { status: 429, body: '{"success":false,"error":{"code":"RATE_LIMIT_EXCEEDED","message":"Too many"}}', headers: { "Retry-After": "3600" } },
    ]);
    await assert.rejects(client.core.listRegions(), (err) => {
      assert.ok(err instanceof arianet.RateLimitError);
      assert.equal(err.code, ErrorCode.RATE_LIMIT_EXCEEDED);
      assert.equal(err.retryAfter, 3600);
      return true;
    });
    assert.deepEqual(waits, []);
    assert.equal(seen.length, 1);
  });

  it("bounds the retries", async () => {
    const { client, seen } = await setup([{ status: 503 }, { status: 503 }, { status: 503 }], { maxRetries: 2 });
    await assert.rejects(client.cloud.listVolumes(), arianet.InternalServerError);
    assert.equal(seen.length, 3);
  });

  it("does not repeat an unsafe write after a 503", async () => {
    const { client, seen } = await setup([{ status: 503, body: '{"error":"busy","code":"core_unavailable"}' }]);
    await assert.rejects(client.cloud.createVolume({ size: 10 }), (err) => err.code === ErrorCode.CORE_UNAVAILABLE);
    assert.equal(seen.length, 1);
  });

  it("keeps the generated Idempotency-Key across retries", async () => {
    const { client, seen } = await setup([{ status: 502 }, { status: 202, body: '{"success":true,"data":{"id":9}}' }]);
    await client.core.createServer({ plan_id: 1 });
    assert.equal(seen.length, 2);
    assert.ok(seen[0].headers["idempotency-key"]);
    assert.equal(seen[0].headers["idempotency-key"], seen[1].headers["idempotency-key"]);
  });

  it("sends an explicit Idempotency-Key", async () => {
    const { client, seen } = await setup([{ status: 200 }]);
    await client.cloud.createVolume({}, { idempotencyKey: "k-1" });
    assert.equal(seen[0].headers["idempotency-key"], "k-1");
  });

  it("retries a read after a dropped connection", async () => {
    const { client, seen } = await setup([{ drop: true }, { status: 200 }]);
    await client.cloud.listImages();
    assert.equal(seen.length, 2);
  });

  it("does not retry an unsafe write after a dropped connection", async () => {
    const { client, seen } = await setup([{ drop: true }, { status: 200 }]);
    await assert.rejects(client.cloud.createVolume({}), arianet.APIConnectionError);
    assert.equal(seen.length, 1);
  });

  const shapes = [
    [402, '{"success":false,"error":{"code":"INSUFFICIENT_BALANCE","message":"Not enough balance"}}', arianet.PaymentRequiredError, ErrorCode.INSUFFICIENT_BALANCE, "Not enough balance", undefined],
    [403, '{"error":"Verify your identity","code":"identity_needed","reason":"identity_hold"}', arianet.PermissionDeniedError, ErrorCode.IDENTITY_NEEDED, "Verify your identity", "identity_hold"],
    [404, '{"code":"not_found","message":"No such server"}', arianet.NotFoundError, ErrorCode.NOT_FOUND, "No such server", undefined],
    [400, "<html>bad</html>", arianet.BadRequestError, "unexpected_response", "request failed with HTTP 400", undefined],
  ];
  for (const [status, body, Cls, code, message, reason] of shapes) {
    it(`reads the HTTP ${status} error shape`, async () => {
      const { client } = await setup([{ status, body, headers: { "X-Request-Id": "req-1" } }]);
      await assert.rejects(client.hosting.listAccounts(), (err) => {
        assert.ok(err instanceof Cls, err.constructor.name);
        assert.deepEqual([err.status, err.code, err.message, err.reason, err.requestId], [status, code, message, reason, "req-1"]);
        return true;
      });
    });
  }

  it("treats success:false with HTTP 200 as an error", async () => {
    const { client } = await setup([{ status: 200, body: '{"success":false,"error":{"code":"NO_DEFAULT_WALLET","message":"No wallet"}}' }]);
    await assert.rejects(client.core.getBalance(), (err) => err.code === ErrorCode.NO_DEFAULT_WALLET);
  });

  it("sends the region header", async () => {
    const { client, seen } = await setup([{ status: 200 }, { status: 200 }]);
    await client.regionalVps.withRegion("iran-1").listServers();
    await client.regionalVps.listServers({ region: "iran-2" });
    assert.equal(seen[0].headers["arianet-region"], "iran-1");
    assert.equal(seen[1].headers["arianet-region"], "iran-2");
  });

  it("does not follow redirects", async () => {
    const other = await mockServer([]);
    const { client } = await setup([{ status: 302, body: "", headers: { Location: `${other.url}/steal` } }]);
    await assert.rejects(client.core.getMe(), (err) => err.status === 302);
    assert.equal(other.seen.length, 0);
  });

  it("requires https", () => {
    assert.throws(() => new Client({ token: "t", baseUrl: "http://api.example.com" }), arianet.ArianetError);
  });

  it("calls paths this version does not have", async () => {
    const { client, seen } = await setup([{ status: 200, body: '{"ok":true}' }]);
    assert.deepEqual(await client.request("GET", "/cloud/v1/something-new", { query: { a: true } }), { ok: true });
    assert.equal(seen[0].url, "/cloud/v1/something-new?a=true");
  });

  it("sends the body as JSON", async () => {
    const { client, seen } = await setup([{ status: 201 }]);
    await client.cloud.createVolume({ name: "data", size: 10 });
    assert.deepEqual(JSON.parse(seen[0].body), { name: "data", size: 10 });
    assert.equal(seen[0].headers["content-type"], "application/json");
  });
});
