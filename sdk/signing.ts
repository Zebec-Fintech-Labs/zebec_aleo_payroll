/**
 * Admin-side signing of `TokenPrice` messages.
 *
 * On-chain, `create_stream_private` verifies
 * `std::sig::verify_schnorr(price_signature, config.admin, price_message)`
 * where `price_message = BHP256::hash_to_field(token_price)`. Off-chain we
 * reproduce the message field via {@link tokenPriceMessage} and sign it as an
 * Aleo value with the admin's private key.
 */

import { Address, PrivateKey, Signature } from "@provablehq/sdk";
import { tokenPriceMessage } from "./hashing.js";
import type { TokenPrice } from "./types.js";

/**
 * Sign a `TokenPrice` with the config admin's private key. Returns the
 * signature literal (`sign1...`) to pass as the `price_signature` input of
 * `create_stream_private`.
 */
export function signTokenPrice(
  privateKey: string | PrivateKey,
  tokenPrice: TokenPrice,
): string {
  const key =
    typeof privateKey === "string" ? PrivateKey.from_string(privateKey) : privateKey;
  const message = tokenPriceMessage(tokenPrice);
  const signature: Signature = key.signValue(message);
  try {
    return signature.toString();
  } finally {
    signature.free();
  }
}

/**
 * Verify a `TokenPrice` signature against an admin address. Useful for
 * sanity-checking signatures produced elsewhere.
 */
export function verifyTokenPriceSignature(
  address: string,
  tokenPrice: TokenPrice,
  signature: string,
): boolean {
  const message = tokenPriceMessage(tokenPrice);
  const sig = Signature.from_string(signature);
  try {
    return sig.verifyValue(Address.from_string(address), message);
  } finally {
    sig.free();
  }
}
