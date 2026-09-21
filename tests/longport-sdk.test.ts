import test from "node:test";
import assert from "node:assert/strict";
import { Config, QuoteContext } from "longport";

// Exercise the actual addon: quote tests mock the transport and cannot catch
// an incompatible Linux binary or changes to the native configuration API.
test("LongPort native addon loads and constructs API-key configuration", () => {
  const config = new Config({
    appKey: "test-app",
    appSecret: "test-secret",
    accessToken: "test-token",
    enablePrintQuotePackages: false,
  });
  assert.ok(config instanceof Config);
  assert.equal(typeof QuoteContext.new, "function");
  assert.equal(typeof QuoteContext.prototype.quote, "function");
  assert.equal(typeof QuoteContext.prototype.staticInfo, "function");
});
