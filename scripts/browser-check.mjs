import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : process.platform === "darwin"
      ? { channel: "chrome" }
      : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const origin = process.env.TEST_BASE_URL || "http://localhost:3003";
await page.goto(`${origin}/demo`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "资产总览", exact: true }).waitFor();
await page.screenshot({
  path: "docs/screenshots/dashboard-desktop.png",
  fullPage: true,
});
for (const width of [360, 768, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  for (const path of [
    "/demo",
    "/demo/assets",
    "/demo/transactions",
    "/demo/settings",
    "/demo/assets/broker~stock-aapl",
    "/login",
    "/register",
  ]) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    assert.ok(
      size.scroll <= size.width,
      `${path} overflows at ${width}: ${JSON.stringify(size)}`,
    );
  }
  console.log(`Responsive ${width}px: 7 routes passed`);
}
await page.setViewportSize({ width: 360, height: 900 });
await page.goto(`${origin}/demo`, { waitUntil: "networkidle" });
await page.screenshot({
  path: "docs/screenshots/dashboard-mobile.png",
  fullPage: true,
});
await page.getByRole("button", { name: "隐藏金额", exact: true }).click();
assert.ok((await page.getByText("••••••", { exact: true }).count()) > 0);
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: "显示金额", exact: true }).click();
const email = `qa-${Date.now()}@example.test`;
const password = "AssetAtlas-Test-2026!";
await page.goto(`${origin}/register`, { waitUntil: "networkidle" });
await page.getByLabel("你的称呼").fill("测试用户");
await page.getByLabel("邮箱地址").fill(email);
await page.getByLabel("密码", { exact: true }).fill(password);
await page.getByLabel("确认密码", { exact: true }).fill(password);
await page.getByRole("button", { name: "创建我的账户" }).click();
await page.waitForURL("**/dashboard");
await page.getByRole("heading", { name: "资产总览", exact: true }).waitFor();
await page.goto(`${origin}/assets/new`, { waitUntil: "networkidle" });
await page.getByLabel("数量（元）").fill("100000");
await page.getByRole("button", { name: "保存记录" }).click();
await page.waitForURL("**/assets");
await page.goto(`${origin}/dashboard`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "完成期初录入" }).click();
await page
  .getByRole("button", { name: "完成期初录入" })
  .waitFor({ state: "detached" });
await page.goto(`${origin}/transactions/new`, { waitUntil: "networkidle" });
await page.getByLabel("记录类型").selectOption("deposit");
await page.getByLabel("数量（元）").fill("10000");
await page.getByLabel("估值依据 / 变更原因（必填）").fill("银行入金回单");
await page.getByRole("button", { name: "保存记录" }).click();
await page.waitForURL("**/transactions");
const portfolio = await page.evaluate(async () =>
  fetch("/api/portfolio").then((r) => r.json()),
);
assert.equal(portfolio.total, "110000");
assert.equal(portfolio.pnl, "0");
assert.equal(portfolio.netFlow, "10000");
for (const width of [360, 768, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  for (const path of [
    "/dashboard",
    "/assets/new",
    "/transactions/new",
    "/settings",
  ]) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `signed-in ${path} overflow ${width}`,
    );
  }
}
console.log(
  "Registration → automatic sign-in → opening balance → initialize → deposit → correct P&L: passed",
);
assert.equal(errors.length, 0, errors.join("\n"));
console.log("Browser runtime errors: 0");
await browser.close();
