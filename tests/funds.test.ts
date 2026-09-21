import test from "node:test";
import assert from "node:assert/strict";
import { fundList, fundQuote } from "../src/server/funds";

const nav = (rows: unknown, extra = "") =>
  `var ishb=false;var fS_code="000001";var Data_netWorthTrend=${JSON.stringify(rows)};${extra}`;
const older = Date.parse("2025-01-01T00:00:00+08:00");
const newer = Date.parse("2025-01-02T00:00:00+08:00");

test("fund directory parses JSON without executing provider scripts", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        'var r = [["000001","HXCZ","华夏成长","混合型","HUAXIACHENGZHANG"]];throw new Error("must never run");',
      ),
  );
  assert.deepEqual(await fundList(), [{ code: "000001", name: "华夏成长" }]);
});

test("fund NAV uses newest unit NAV, Shanghai date and legacy IDs", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://fund.eastmoney.com/pingzhongdata/000001.js");
    return new Response(
      nav(
        [
          { x: newer, y: 1.2345 },
          { x: older, y: 1.1 },
        ],
        'var Data_ACWorthTrend=[[1735747200000,9]];throw new Error("never run");',
      ),
    );
  });
  const before = Date.now();
  const quote = await fundQuote("000001.OF");
  assert.equal(quote.value, "1.2345");
  assert.match(quote.source, /天天基金 已公布净值 2025-01-02/);
  assert.ok(Date.parse(quote.asOf) >= before);
  assert.equal((await fundQuote("000001")).value, quote.value);
});

test("fund NAV rejects malformed data, money-market yields and incorrect identities", async (t) => {
  let body = "";
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  for (const value of [
    "<html>unavailable</html>",
    nav([]),
    nav([{ x: newer, y: -1 }]),
    nav([{ x: newer, y: null }]),
    nav([{ x: Date.now() + 86400_000, y: 1 }]),
    nav([{ x: newer, y: 1 }]).replace('"000001"', '"000002"'),
    nav([{ x: newer, y: 1 }]).replace("ishb=false", "ishb=true"),
    'var ishb=false;var fS_code="000001";var Data_netWorthTrend=(()=>{throw new Error("executed")})();',
  ]) {
    body = value;
    await assert.rejects(fundQuote("000001"), /天天基金|货币基金/);
  }
  await assert.rejects(fundQuote("../../private"), /基金代码无效/);
});

test("fund requests report network and rate errors, malformed directory is not empty success", async (t) => {
  let response = new Response("", { status: 429 });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(fundList(), /请求过于频繁/);
  response = new Response("var r = []; ");
  await assert.rejects(fundList(), /目录格式异常/);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(fundList(), /连接失败或超时/);
});
