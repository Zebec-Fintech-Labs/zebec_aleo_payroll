import assert from "node:assert";
import { describe, it } from "mocha";

import {
  configNameToField,
  streamCountKey,
  streamRefKey,
  streamTokenFeeMessage,
  whitelistKey,
} from "../../sdk/hashing.js";

// Known vector produced on-chain with `leo run` (Leo 4.4.1, testnet) against
// the StreamTokenFee struct:
//   { config: 12345field, stream_token: 'token', stream_fee_amount: 50000u128,
//     expiry: 1893456000i64, nonce: 5field }
// If this matches, the off-chain BHP256 hashing reproduces
// `BHP256::hash_to_field` for StreamTokenFee exactly.
//
// To regenerate: hash the plaintext above with BHP256::hash_to_field on-chain
// and record the resulting field.
//
// Whitelist key vector is unchanged (WhitelistKey struct unchanged).
const WHITELIST_KEY =
  "5949549857295180779432337181339499322185250953286779710073517871832327878616field";
const STREAM_TOKEN_FEE_MESSAGE =
  "1406243592912000924737549262953687874236215765749277301427381915962454187152field";

describe("hashing — StreamTokenFee (known on-chain vector)", () => {
  it("streamTokenFeeMessage reproduces the on-chain fee message", () => {
    const message = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.equal(message, STREAM_TOKEN_FEE_MESSAGE);
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
// `BHP256::hash_to_field(StreamRefKey { account, config, index })` and
// `BHP256::hash_to_field(StreamCountKey { account, config })` (Leo 4.4.1).
const REF_KEY_ADDRESS =
  "aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038";
const REF_KEY_CONFIG = 12345n;
const REF_KEY_VECTORS: [bigint, string][] = [
  [
    0n,
    "6020195188621236084074400941031386350611068300278742228244089924752997965268field",
  ],
  [
    1n,
    "6561316225218808297871897282156571022119172125950759523595370864740352486132field",
  ],
  [
    2n,
    "3736302156749057264992416909993913953306681731787592185930978272894613483000field",
  ],
];
const COUNT_KEY_VECTOR =
  "8442124999102044995407373519281975725322734095700296910850922699010126814628field";

describe("hashing — StreamRefKey (known on-chain vectors)", () => {
  it("streamRefKey reproduces the on-chain registry keys", () => {
    for (const [index, expected] of REF_KEY_VECTORS) {
      assert.equal(streamRefKey(REF_KEY_ADDRESS, REF_KEY_CONFIG, index), expected);
    }
  });

  it("different indices produce different keys", () => {
    const [, a] = REF_KEY_VECTORS[0]!;
    const [, b] = REF_KEY_VECTORS[1]!;
    assert.notEqual(a, b);
  });
});

describe("hashing — StreamCountKey (known on-chain vector)", () => {
  it("streamCountKey reproduces the on-chain count key", () => {
    assert.equal(streamCountKey(REF_KEY_ADDRESS, REF_KEY_CONFIG), COUNT_KEY_VECTOR);
  });

  it("different configs produce different keys", () => {
    assert.notEqual(
      streamCountKey(REF_KEY_ADDRESS, REF_KEY_CONFIG),
      streamCountKey(REF_KEY_ADDRESS, 54321n),
    );
  });
});
