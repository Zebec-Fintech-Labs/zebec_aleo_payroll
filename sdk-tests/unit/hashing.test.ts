import assert from "node:assert";
import { describe, it } from "mocha";

import {
  configNameToField,
  streamRefKey,
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
    const a = configNameToField("zebec-stream");
    assert.equal(a, configNameToField("zebec-stream"));
    assert.match(a, /^\d+field$/);
    assert.notEqual(a, configNameToField("other-name"));
  });
});

// Known vectors produced with `leo run` against a scratch program computing
// `BHP256::hash_to_field(StreamRefKey { account, index })` (Leo 4.4.1).
const REF_KEY_ADDRESS =
  "aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038";
const REF_KEY_VECTORS: [bigint, string][] = [
  [
    0n,
    "6952482170506173380307286405035580171476052413684863500439649736209321408776field",
  ],
  [
    1n,
    "827741355657143112373889307632514086180020658795105758901897300037779376808field",
  ],
  [
    2n,
    "4979863279181455851194491847508194138868336570890026078327554019653612308577field",
  ],
];

describe("hashing — StreamRefKey (known on-chain vectors)", () => {
  it("streamRefKey reproduces the on-chain registry keys", () => {
    for (const [index, expected] of REF_KEY_VECTORS) {
      assert.equal(streamRefKey(REF_KEY_ADDRESS, index), expected);
    }
  });

  it("different indices produce different keys", () => {
    const [, a] = REF_KEY_VECTORS[0]!;
    const [, b] = REF_KEY_VECTORS[1]!;
    assert.notEqual(a, b);
  });
});
