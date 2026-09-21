import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
process.env.ENABLE_SCHEDULER = "false";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET =
  "sharing-mcp-test-secret-123456789012345678901234567890";
const origin = "http://localhost:3000";

test("mutual invitations, account scope, revocation, private MCP scopes and standard stdio client", async () => {
  const { app } = await import("../src/server/api");
  const { getDb, uid, now } = await import("../src/server/db");
  const { ensureProfile, wallets } = await import("../src/server/valuation");
  const { recordEvent, eventSchema } = await import("../src/server/ledger");
  const { changeShare } = await import("../src/server/sharing");
  const { createToken, authenticateToken } =
    await import("../src/server/mcp-tokens");
  async function call(
    path: string,
    body?: unknown,
    cookie = "",
    method = "POST",
    extra: Record<string, string> = {},
  ) {
    return app.request(`${origin}/api${path}`, {
      method: body === undefined ? "GET" : method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        "Idempotency-Key": uid(),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function signup(name: string) {
    const response = await call("/auth/sign-up/email", {
      email: `${name}@example.test`,
      name,
      password: "Testing123",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const user = (await response.json()).user.id;
    await ensureProfile(user);
    return {
      user,
      email: `${name}@example.test`,
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
      wallet: (await wallets(user))[0].id,
    };
  }
  const a = await signup("alice"),
    b = await signup("bob"),
    c = await signup("carol");
  const db = getDb();
  const privateWallet = uid();
  await getDb().wallet.create({
    data: {
      id: privateWallet,
      userId: a.user,
      name: "Private wallet",
      type: "综合账户",
    },
  });
  async function opening(
    user: string,
    accountId: string,
    quantity: string,
    instrumentId = "cash-cny",
  ) {
    await recordEvent(
      user,
      eventSchema.parse({
        type: "opening",
        accountId,
        instrumentId,
        quantity,
        occurredAt: "2026-01-01T00:00:00Z",
        note: "private note",
      }),
      uid(),
    );
  }
  await opening(a.user, a.wallet, "100");
  await opening(a.user, privateWallet, "900");
  await opening(b.user, b.wallet, "200");
  await opening(c.user, c.wallet, "5000");
  assert.equal((await call("/shares")).status, 401);
  assert.equal(
    (await call("/shares", { email: b.email, walletIds: [b.wallet] }, a.cookie))
      .status,
    403,
  );
  const invitation = await call(
    "/shares",
    { email: b.email, walletIds: [a.wallet] },
    a.cookie,
  );
  assert.equal(invitation.status, 201, await invitation.clone().text());
  const id = (await invitation.json()).id;
  assert.equal(
    (await call("/shares", { email: a.email, walletIds: [] }, b.cookie)).status,
    409,
  );
  assert.equal(
    (await call(`/shares/${id}/portfolio`, undefined, a.cookie)).status,
    403,
  );
  assert.equal(
    (await call(`/shares/${id}/accept`, { walletIds: [] }, a.cookie)).status,
    403,
  );
  assert.equal(
    (await call(`/shares/${id}/accept`, { walletIds: [b.wallet] }, c.cookie))
      .status,
    404,
  );
  const pending = await (await call("/shares", undefined, b.cookie)).json();
  assert.equal(pending.items[0].status, "pending");
  assert.ok(!JSON.stringify(pending).includes(a.wallet));
  assert.equal(
    (await call(`/shares/${id}/accept`, { walletIds: [b.wallet] }, b.cookie))
      .status,
    200,
  );
  for (const cookie of [a.cookie, b.cookie]) {
    const shared = await (
      await call(`/shares/${id}/portfolio`, undefined, cookie)
    ).json();
    assert.equal(shared.total, "300");
    assert.equal(shared.members.length, 2);
    const text = JSON.stringify(shared);
    assert.ok(!text.includes(privateWallet));
    assert.ok(!text.includes("private note"));
    assert.ok(!text.includes(c.wallet));
  }
  assert.equal(
    (await call(`/shares/${id}/portfolio`, undefined, c.cookie)).status,
    404,
  );
  const { inviteShare, sharedPortfolio, allSharedPortfolio } =
    await import("../src/server/sharing");
  const ac = await inviteShare(a.user, {
    email: c.email,
    walletIds: [a.wallet],
  });
  await changeShare(c.user, ac.id, "accept", [c.wallet]);
  assert.equal((await allSharedPortfolio(a.user)).total, "5300");
  assert.equal((await allSharedPortfolio(b.user)).total, "300");
  assert.equal((await allSharedPortfolio(c.user)).total, "5100");
  assert.ok(
    !JSON.stringify(await allSharedPortfolio(b.user)).includes(c.wallet),
  );
  await changeShare(c.user, ac.id, "revoke");
  assert.equal((await allSharedPortfolio(a.user)).total, "300");

  assert.equal(
    (await call(`/assets/${b.wallet}~cash-cny`, undefined, a.cookie)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/assets/${b.wallet}~cash-cny/quantity`,
        { quantity: "0", expectedQuantity: "200", reason: "test" },
        a.cookie,
        "PATCH",
      )
    ).status,
    404,
  );
  assert.equal(
    (await call(`/shares/${id}/wallets`, { walletIds: [] }, a.cookie)).status,
    200,
  );
  assert.equal(
    (await (await call(`/shares/${id}/portfolio`, undefined, b.cookie)).json())
      .total,
    "200",
  );
  // Token responses are never persisted in the idempotency cache or token table.
  const key = uid();
  const created = await call(
    "/mcp-tokens",
    { name: "test agent", expiresInDays: 7 },
    a.cookie,
    "POST",
    { "Idempotency-Key": key },
  );
  assert.equal(created.status, 201, await created.clone().text());
  const token = await created.json();
  assert.ok(await authenticateToken(`Bearer ${token.token}`));
  assert.equal(
    await getDb().mutation.findFirst({ where: { userId: a.user, key: key } }),
    null,
  );
  assert.ok(
    !JSON.stringify(await getDb().mcpToken.findMany()).includes(token.token),
  );
  assert.ok(
    !JSON.stringify(
      await (await call("/mcp-tokens", undefined, a.cookie)).json(),
    ).includes(token.token),
  );
  assert.equal(
    (
      await call("/mcp-tokens", { name: "csrf" }, a.cookie, "POST", {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  async function rpc(
    method: string,
    params: unknown = {},
    bearer = token.token,
    extra: Record<string, string> = {},
  ) {
    return app.request(`${origin}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: uid(), method, params }),
    });
  }
  assert.equal((await rpc("tools/list", {}, "invalid")).status, 401);
  assert.equal(
    (await rpc("tools/list", {}, token.token, { Origin: "https://evil.test" }))
      .status,
    403,
  );
  const initialize = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialize.status, 200, await initialize.clone().text());
  const tools = (await (await rpc("tools/list")).json()).result.tools;
  assert.equal(tools.length, 6);
  assert.ok(
    tools.every(
      (t: { annotations: { readOnlyHint: boolean } }) =>
        t.annotations.readOnlyHint,
    ),
  );
  assert.ok(
    !tools.some((t: { name: string }) => t.name === "list_transactions"),
  );
  const summary = (
    await (
      await rpc("tools/call", { name: "get_portfolio_summary", arguments: {} })
    ).json()
  ).result.structuredContent;
  assert.equal(summary.total, "1000");
  const holdings = (
    await (
      await rpc("tools/call", { name: "list_holdings", arguments: {} })
    ).json()
  ).result.structuredContent;
  assert.equal(holdings.items.length, 2);
  assert.ok(!JSON.stringify(holdings).includes(b.wallet));
  assert.equal(
    (
      await (
        await rpc("tools/call", {
          name: "get_asset_detail",
          arguments: { holdingId: `${b.wallet}~cash-cny` },
        })
      ).json()
    ).result.isError,
    true,
  );
  const transactionDenied = await (
    await rpc("tools/call", { name: "list_transactions", arguments: {} })
  ).json();
  assert.ok(transactionDenied.error || transactionDenied.result?.isError);
  const full = await createToken(a.user, {
    name: "full",
    expiresInDays: 7,
    transactions: true,
  });
  const events = (
    await (
      await rpc(
        "tools/call",
        { name: "list_transactions", arguments: {} },
        full.token,
      )
    ).json()
  ).result.structuredContent;
  assert.equal(events.items.length, 2);
  assert.ok(!JSON.stringify(events).includes(b.wallet));
  assert.ok(!JSON.stringify(events).includes("idempotencyKey"));
  assert.equal(
    (await call(`/mcp-tokens/${token.id}`, {}, b.cookie, "DELETE")).status,
    404,
  );
  assert.equal((await call(`/shares/${id}/revoke`, {}, b.cookie)).status, 200);
  assert.equal(
    (await call(`/shares/${id}/portfolio`, undefined, a.cookie)).status,
    403,
  );
  const second = (
    await (
      await call("/shares", { email: b.email, walletIds: [] }, a.cookie)
    ).json()
  ).id;
  assert.equal(
    (await call(`/shares/${second}/decline`, {}, b.cookie)).status,
    200,
  );
  assert.equal(
    (await call(`/shares/${second}/accept`, { walletIds: [] }, b.cookie))
      .status,
    409,
  );
  const third = (
    await (
      await call("/shares", { email: b.email, walletIds: [] }, a.cookie)
    ).json()
  ).id;
  await getDb().assetShare.update({
    where: { id: third },
    data: { expiresAt: "2000-01-01T00:00:00Z" },
  });
  await assert.rejects(
    async () => await changeShare(b.user, third, "accept", []),
    /失效/,
  );
  // Test the downloaded stdio adapter using the actual official SDK client.
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await app.request(`${origin}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks).length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("public/mcp/asset-atlas-bridge.mjs")],
    env: {
      ASSET_ATLAS_URL: `http://127.0.0.1:${address.port}`,
      ASSET_ATLAS_TOKEN: token.token,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "official-sdk-smoke", version: "1.0" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({
      name: "get_portfolio_summary",
      arguments: {},
    });
    assert.equal(
      (result.structuredContent as { total: string } | undefined)?.total,
      "1000",
    );
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      http.close((e) => (e ? reject(e) : resolve())),
    );
  }
  assert.equal(
    (await call(`/mcp-tokens/${token.id}`, {}, a.cookie, "DELETE")).status,
    200,
  );
  assert.equal((await rpc("tools/list")).status, 401);
  await getDb().mcpToken.update({
    where: { id: full.id },
    data: { expiresAt: "2000-01-01T00:00:00Z" },
  });
  assert.equal(await authenticateToken(`Bearer ${full.token}`), null);
  assert.equal(await getDb().ledgerEvent.count(), 4);
});
