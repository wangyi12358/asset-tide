import test from "node:test";
import assert from "node:assert/strict";
import type { QuoteContext } from "longport";
import { longportSdk } from "../src/server/longport-sdk";
import {
  isHongKongStock,
  longportQuote,
  longportStatus,
  longportSymbol,
} from "../src/server/longport";
import type { Instrument } from "../src/lib/types";

const instrument: Instrument = {
  id: "hk-test",
  ownerId: null,
  name: "Alibaba",
  symbol: "09988",
  market: "HKEX",
  type: "stock",
  currency: "HKD",
  unit: "股",
  providerId: "9988:HKEX",
  purity: "1",
  quoteBasis: "unit",
};
const keys = [
  "LONGPORT_APP_KEY",
  "LONGPORT_APP_SECRET",
  "LONGPORT_ACCESS_TOKEN",
] as const;

test("LongPort maps HK symbols, validates quotes and hides credential-bearing SDK errors", async (t) => {
  const saved = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    }),
  );
  keys.forEach((key) => delete process.env[key]);
  assert.equal(longportStatus(), "disabled");
  process.env.LONGPORT_APP_KEY = "test-app";
  assert.equal(longportStatus(), "incomplete");
  await assert.rejects(longportQuote(instrument), /配置不完整/);
  process.env.LONGPORT_APP_SECRET = "test-secret";
  process.env.LONGPORT_ACCESS_TOKEN = "private-test-token";
  assert.equal(longportStatus(), "ready");
  assert.equal(longportSymbol("09988"), "9988.HK");
  assert.equal(longportSymbol("00700"), "700.HK");
  assert.equal(longportSymbol("0700.HK"), "700.HK");
  for (const invalid of ["BABA", "0", "700.US", "700:NASDAQ", "123456"])
    assert.throws(() => longportSymbol(invalid), /代码无效/);
  assert.equal(isHongKongStock(instrument), true);
  assert.equal(
    isHongKongStock({ ...instrument, market: "NASDAQ", currency: "HKD" }),
    false,
  );

  const quoteTime = new Date(Date.now() - 15 * 60_000);
  let price = "125.250";
  let currency = "HKD";
  let time = quoteTime;
  let responseSymbol = "9988.HK";
  let failure: Error | undefined;
  const requested: string[][] = [];
  const ctx = {
    quote: async (symbols: string[]) => {
      requested.push(symbols);
      if (failure) throw failure;
      return [
        {
          symbol: responseSymbol,
          lastDone: { toString: () => price },
          timestamp: time,
        },
      ];
    },
    staticInfo: async () => [{ symbol: "9988.HK", currency }],
  } as unknown as QuoteContext;
  const factory = t.mock.method(longportSdk, "create", async () => ctx);
  const result = await longportQuote(instrument);
  assert.deepEqual(requested, [["9988.HK"]]);
  assert.equal(result.value, "125.250");
  assert.equal(
    result.asOf,
    quoteTime.toISOString(),
    "preserve delayed quote time",
  );
  assert.match(result.source, /长桥.*可能延迟/);
  currency = "USD";
  await assert.rejects(longportQuote(instrument), /币种不匹配/);
  currency = "HKD";
  responseSymbol = "700.HK";
  await assert.rejects(longportQuote(instrument), /未返回/);
  responseSymbol = "9988.HK";
  for (const invalid of ["0", "-1", "NaN", "Infinity"]) {
    price = invalid;
    await assert.rejects(longportQuote(instrument), /价格或报价时间无效/);
  }
  price = "125.250";
  for (const invalid of [
    new Date(NaN),
    new Date(0),
    new Date(Date.now() + 60_000),
  ]) {
    time = invalid;
    await assert.rejects(longportQuote(instrument), /价格或报价时间无效/);
  }
  time = quoteTime;
  for (const [raw, message] of [
    ["401003 token expired private-test-token", /已过期/],
    ["403203 apikey illegal test-secret", /认证失败/],
    ["403205 ip is not allowed", /IP 白名单/],
    ["301606 rate limit", /过于频繁/],
    ["no quote permission private-test-token", /行情权限/],
    ["network error private-test-token", /行情请求失败/],
  ] as const) {
    failure = new Error(raw);
    await assert.rejects(longportQuote(instrument), (error: Error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /private-test-token|test-secret/);
      return true;
    });
  }
  assert.equal(
    factory.mock.callCount(),
    1,
    "reuse the context across quote refreshes",
  );
});
