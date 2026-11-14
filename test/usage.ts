// Compiled with `npm run typecheck` to keep the public types usable; never run.
import { APIError, Client, ErrorCode, RateLimitError, type CloudListServersQuery } from "arianet";

async function usage(): Promise<void> {
  const client = new Client({ token: "t", maxRetries: 2 });
  const query: CloudListServersQuery = { page: 1, per_page: 50, label_selector: "env=prod" };
  const page = await client.cloud.listServers(query);
  console.log(page.data);
  await client.core.createServer({ plan_id: 1 }, { idempotencyKey: "k" });
  await client.regionalVps.withRegion("iran-1").listServers();
  await client.sms.getReportSummary({ from: "2026-01-01", to: "2026-01-31" });
  try {
    await client.cloud.getServer(42);
  } catch (err) {
    if (err instanceof RateLimitError) console.log(err.retryAfter);
    if (err instanceof APIError && err.code === ErrorCode.NOT_FOUND) console.log(err.status);
  }
}
void usage;
