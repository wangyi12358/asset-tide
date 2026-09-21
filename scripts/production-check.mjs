import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { Client } from "pg";
import { chromium } from "@playwright/test";
const database = new URL(
  process.env.TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:5432/asset_atlas_test",
);
if (!database.pathname.endsWith("_test"))
  throw new Error("Use a test database");
const schema = `production_${randomBytes(8).toString("hex")}`;
const pg = new Client({ connectionString: database.toString() });
await pg.connect();
await pg.query(`CREATE SCHEMA "${schema}"`);
await pg.query(`SET search_path TO "${schema}"`);
for (const entry of readdirSync("prisma/migrations", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))) {
  await pg.query(
    readFileSync(
      `prisma/migrations/${entry.name}/migration.sql`,
      "utf8",
    ).replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
  );
}
database.searchParams.set("schema", schema);
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const dir = mkdtempSync(join(tmpdir(), "asset-atlas-production-"));
const cronSecret = randomBytes(32).toString("hex");
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
const processServer = spawn(process.execPath, [".next/standalone/server.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64"),
    DATABASE_URL: database.toString(),
    ENABLE_SCHEDULER: "false",
    VERCEL: "1",
    VERCEL_ENV: "production",
    CRON_SECRET: cronSecret,
  },
  stdio: "ignore",
});
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, "production service starts");
  const demo = await fetch(`http://127.0.0.1:${port}/demo`);
  assert.equal(demo.status, 200);
  const html = await demo.text();
  assert.ok(html.includes("AssetAtlas"));
  const asset = html.match(/src="([^"]+\.js[^\"]*)"/);
  assert.ok(asset);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}${asset[1].replaceAll("&amp;", "&")}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/portfolio`)).status,
    401,
  );
  const privatePage = await fetch(`http://127.0.0.1:${port}/assets/new`, {
    redirect: "manual",
  });
  assert.equal(privatePage.status, 307);
  assert.ok(privatePage.headers.get("location").includes("returnTo="));
  const cronUrl = `http://127.0.0.1:${port}/api/cron/daily`;
  assert.equal((await fetch(cronUrl)).status, 401);
  assert.equal((await fetch(cronUrl, { method: "HEAD" })).status, 405);
  const cron = await fetch(cronUrl, {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(cron.status, 200, await cron.clone().text());
  assert.match(cron.headers.get("cache-control"), /no-store/);
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "darwin" ? { channel: "chrome" } : {}),
  });
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${port}`;
    let refreshRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/refresh") refreshRequests++;
    });
    await page.goto(`${origin}/demo`);
    await page
      .getByRole("heading", { name: "资产总览", exact: true })
      .waitFor();
    assert.equal(refreshRequests, 0, "demo never refreshes private data");
    const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { Origin: origin },
      data: {
        name: "Production smoke",
        email: `smoke-${randomBytes(6).toString("hex")}@example.test`,
        password: "Testing123!!",
      },
    });
    assert.equal(signup.status(), 200);
    const firstRefresh = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/refresh",
    );
    await page.goto(`${origin}/dashboard`);
    assert.equal((await (await firstRefresh).json()).skipped, false);
    const secondRefresh = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/refresh",
    );
    await page.reload();
    assert.equal((await (await secondRefresh).json()).skipped, true);
    await page.goto(`${origin}/settings`);
    await page
      .getByText("完整数据库备份由部署者在本机保存。", { exact: false })
      .waitFor();
    await page.getByText("无人访问时不持续采集。", { exact: false }).waitFor();
  } finally {
    await browser.close();
  }
  console.log(
    "Production standalone: pages and JS served, auth enforced, cron secured, browser auto-refresh/cooldown and settings verified, demo isolated.",
  );
} finally {
  processServer.kill("SIGTERM");
  await new Promise((resolve) => processServer.once("exit", resolve));
  await pg.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pg.end();
  rmSync(dir, { recursive: true, force: true });
}
