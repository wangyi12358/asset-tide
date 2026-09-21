import "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
process.env.ENABLE_SCHEDULER = "false";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET =
  "test-secret-for-integration-only-do-not-use-in-production-123456";
const origin = "http://localhost:3000";
const password = "Atlas8!!";

test("Better Auth and Hono: automatic sign-in without verification, private API, CSRF, isolation, export, password reset", async () => {
  const { app, csv } = await import("../src/server/api");
  const { getDb } = await import("../src/server/db");
  async function request(
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
        "Idempotency-Key": crypto.randomUUID(),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const extractCookies = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  function mail(email: string, kind: string) {
    return (existsSync("data/mailbox") ? readdirSync("data/mailbox") : [])
      .map((f) => JSON.parse(readFileSync(`data/mailbox/${f}`, "utf8")))
      .filter((m) => m.to === email && m.kind === kind)
      .at(-1);
  }
  async function register() {
    const email = `integration-${crypto.randomUUID()}@example.test`;
    const signup = await request("/auth/sign-up/email", {
      email,
      password,
      name: "Integration",
      callbackURL: "/dashboard",
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    const signupCookie = extractCookies(signup);
    assert.match(signupCookie, /session_token/);
    const immediate = await request("/portfolio", undefined, signupCookie);
    assert.equal(immediate.status, 200);
    assert.equal((await immediate.json()).emailVerified, false);
    assert.equal(
      mail(email, "verify"),
      undefined,
      "registration sends no verification email",
    );
    await request("/auth/sign-out", {}, signupCookie);
    const login = await request("/auth/sign-in/email", { email, password });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = extractCookies(login);
    assert.match(cookie, /session_token/);
    const portfolio = await request("/portfolio", undefined, cookie);
    assert.equal(portfolio.status, 200);
    const data = await portfolio.json();
    assert.equal(data.holdings.length, 0);
    return { email, cookie, account: data.accounts[0].id };
  }
  assert.equal((await request("/portfolio")).status, 401);
  const tooShort = await request("/auth/sign-up/email", {
    email: `short-${crypto.randomUUID()}@example.test`,
    password: "Atlas7!",
    name: "Password length check",
  });
  assert.equal(tooShort.status, 400);
  assert.equal((await tooShort.json()).code, "PASSWORD_TOO_SHORT");
  const a = await register();
  const b = await register();
  const input = {
    type: "opening",
    accountId: a.account,
    instrumentId: "cash-cny",
    quantity: "100000",
    occurredAt: new Date().toISOString(),
    note: "test",
  };
  const key = crypto.randomUUID();
  const opening = await request("/transactions", input, a.cookie, "POST", {
    "Idempotency-Key": key,
  });
  assert.equal(opening.status, 201, await opening.clone().text());
  const event = await opening.json();
  assert.equal(
    (
      await request("/transactions", input, a.cookie, "POST", {
        "Idempotency-Key": key,
      })
    ).status,
    201,
  );
  assert.equal(
    (await request("/transactions/" + event.id, undefined, b.cookie)).status,
    404,
  );
  assert.equal(
    (await request("/assets/" + a.account + "~cash-cny", undefined, b.cookie))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        "/accounts/" + a.account,
        { name: "hacked" },
        b.cookie,
        "PATCH",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/accounts", { name: "CSRF test" }, a.cookie, "POST", {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const exportA = await (await request("/export", undefined, a.cookie)).json();
  const exportB = await (await request("/export", undefined, b.cookie)).json();
  assert.equal(exportA.holdings[0].quantity, "100000");
  assert.equal(exportB.holdings.length, 0);
  assert.ok(!JSON.stringify(exportB).includes(a.account));
  assert.equal(exportA.version, "1.0");
  assert.ok(csv([{ name: '=HYPERLINK("evil")' }]).includes("'=HYPERLINK"));
  const reset = await request("/auth/request-password-reset", {
    email: a.email,
    redirectTo: "/reset-password",
  });
  assert.equal(reset.status, 200);
  const resetMail = mail(a.email, "reset");
  assert.ok(resetMail);
  // Provider sends a callback route that redirects with the reset token.
  const resetCallback = await app.request(resetMail.url, {
    headers: { Origin: origin },
  });
  const location = resetCallback.headers.get("location") || resetMail.url;
  const token = new URL(location, origin).searchParams.get("token");
  assert.ok(token);
  const changed = await request("/auth/reset-password", {
    newPassword: "Newpass8",
    token,
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await request("/portfolio", undefined, a.cookie)).status, 401);
  assert.equal(
    (
      await request("/auth/reset-password", {
        newPassword: password + "other",
        token,
      })
    ).status,
    400,
  );
  const count = { n: await getDb().ledgerEvent.count({}) } as {
    n: number;
  };
  assert.equal(count.n, 1);
});
