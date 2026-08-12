import assert from "node:assert";
import { describe, it } from "mocha";

import {
  configNameToField,
  feeTierKey,
  tokenPriceMessage,
  whitelistKey,
} from "../../sdk/hashing.js";

// Known vectors produced on-chain with `leo run` (Leo 4.3.4, testnet) —
// see the scratch program used during development. If these match, the
// off-chain BHP256 hashing reproduces `BHP256::hash_to_field` exactly.
const PRICE_HASH =
  "2465286061713934066083951265206464108512855460089046687757762326215251262203field";
const TIER_KEY =
  "4280435061793654878309538122108291005136850793721184370576372014297830104823field";
const WHITELIST_KEY =
  "5949549857295180779432337181339499322185250953286779710073517871832327878616field";

// console.log("whitelistkey", whitelistKey("12345", "my_token"));
// console.log("pricehash", tokenPriceMessage({
//   config: 12345n,
//   streamToken: "token",
//   streamTokenPriceUsd: 1_000_000n,
//   aleoPriceUsd: 500_000n,
//   priceExpiry: 1_893_456_000n,
//   nonce: 5n,
// }));

describe("hashing (known on-chain vectors)", () => {
  it("hashes a TokenPrice exactly like BHP256::hash_to_field on-chain", () => {
    const message = tokenPriceMessage({
      config: 12345n,
      streamToken: "token",
      streamTokenPriceUsd: 1_000_000n,
      aleoPriceUsd: 500_000n,
      priceExpiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.equal(message, PRICE_HASH);
  });

  it("computes the fee_tiers mapping key like on-chain", () => {
    assert.equal(feeTierKey("12345", 3), TIER_KEY);
    assert.equal(feeTierKey(12345n, 3), TIER_KEY);
    assert.equal(feeTierKey("12345field", 3), TIER_KEY);
  });

  it("computes the whitelisted_token_programs mapping key like on-chain", () => {
    assert.equal(whitelistKey("12345", "my_token"), WHITELIST_KEY);
  });
});

describe("configNameToField", () => {
  it("is deterministic and returns a canonical field literal", () => {
    const a = configNameToField("zebec-payroll");
    assert.equal(a, configNameToField("zebec-payroll"));
    assert.match(a, /^\d+field$/);
    assert.notEqual(a, configNameToField("other-name"));

  });
});
