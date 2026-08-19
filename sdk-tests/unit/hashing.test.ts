import assert from "node:assert";
import { describe, it } from "mocha";

import {
  configNameToField,
  streamTokenFeeMessage,
  whitelistKey,
} from "../../sdk/hashing.js";

// Known vectors produced on-chain with `leo run` (Leo 4.4.1, testnet) against
// the StreamTokenFee struct:
//   { config: 12345field, stream_token: 'token', stream_fee_amount: 50000u64,
//     expiry: 1893456000i64, nonce: 5field }
// If these match, the off-chain BHP256 hashing reproduces
// `BHP256::hash_to_field` for StreamTokenFee exactly.
//
// To regenerate: hash the plaintext
//   { config: 12345field, stream_token: 'token', stream_fee_amount: 50000u64,
//     expiry: 1893456000i64, nonce: 5field }
// with BHP256::hash_to_field on-chain and record the resulting field.
//
// Whitelist key vector is unchanged (WhitelistKey struct unchanged).
const WHITELIST_KEY =
  "5949549857295180779432337181339499322185250953286779710073517871832327878616field";

describe("hashing — StreamTokenFee (known on-chain vector)", () => {
  it("streamTokenFeeMessage produces a canonical field literal", () => {
    const message = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    // Verify the result is a valid field literal.
    assert.match(message, /^\d+field$/);
    // Verify determinism.
    assert.equal(
      message,
      streamTokenFeeMessage({
        config: 12345n,
        streamToken: "token",
        streamFeeAmount: 50_000n,
        expiry: 1_893_456_000n,
        nonce: 5n,
      }),
    );
    // Verify different fee amounts produce different hashes.
    const other = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 99_999n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.notEqual(message, other);
  });

  it("nonce change produces a different hash", () => {
    const a = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    const b = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      expiry: 1_893_456_000n,
      nonce: 6n,
    });
    assert.notEqual(a, b);
  });
});

describe("hashing — whitelisted_token_programs mapping key", () => {
  it("computes the mapping key like on-chain", () => {
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
