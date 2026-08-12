import assert from "node:assert";
import { Account } from "@provablehq/sdk";
import { describe, it } from "mocha";

import { signTokenPrice, verifyTokenPriceSignature } from "../../sdk/signing.js";
import type { TokenPrice } from "../../sdk/types.js";

// Well-known Leo CLI default private key (public, used for tests only).
const TEST_PRIVATE_KEY =
  "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";

const tokenPrice: TokenPrice = {
  config: 12345n,
  streamToken: "token",
  streamTokenPriceUsd: 1_000_000n,
  aleoPriceUsd: 500_000n,
  priceExpiry: 1_893_456_000n,
  nonce: 5n,
};

describe("signTokenPrice", () => {
  it("produces a sign1... signature that verifies against the signer address", () => {
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signTokenPrice(TEST_PRIVATE_KEY, tokenPrice);
    assert.ok(signature.startsWith("sign1"));
    assert.ok(
      verifyTokenPriceSignature(account.address().to_string(), tokenPrice, signature),
    );
  });

  it("fails verification for a different price", () => {
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signTokenPrice(TEST_PRIVATE_KEY, tokenPrice);
    const other = { ...tokenPrice, nonce: 6n };
    assert.ok(
      !verifyTokenPriceSignature(account.address().to_string(), other, signature),
    );
  });

  it("fails verification for a different address", () => {
    const signature = signTokenPrice(TEST_PRIVATE_KEY, tokenPrice);
    const other = new Account();
    assert.ok(
      !verifyTokenPriceSignature(other.address().to_string(), tokenPrice, signature),
    );
  });
});
