import { strict as assert } from "node:assert";
import { Plaintext } from "@provablehq/sdk";
import { describe, it } from "mocha";

import {
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  identLiteral,
  merkleProofToPlaintext,
  merkleProofsToPlaintext,
  parsePayroll,
  parsePayrollConfig,
  parseStreamAnchor,
  parseStructMembers,
  payrollToPlaintext,
  streamAnchorToPlaintext,
  streamTokenFeeToPlaintext,
} from "../../sdk/plaintext.js";
import type { Payroll, StreamAnchor } from "../../sdk/types.js";

const RECEIVER = "aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4";
const ADMIN = "aleo129nrpl0dxh4evdsan3f4lyhz5pdgp6klrn5atp37ejlavswx5czsk0j5dj";

describe("fieldLiteral", () => {
  it("normalizes bare digits, suffixed strings, bigints and numbers", () => {
    assert.equal(fieldLiteral("123"), "123field");
    assert.equal(fieldLiteral("123field"), "123field");
    assert.equal(fieldLiteral(123n), "123field");
    assert.equal(fieldLiteral(123), "123field");
  });
});

describe("identLiteral", () => {
  it("wraps valid bare identifiers in single quotes", () => {
    assert.equal(identLiteral("my_token"), "'my_token'");
    assert.equal(identLiteral("x"), "'x'");
  });
  it("rejects invalid identifiers", () => {
    assert.throws(() => identLiteral("1foo"));
    assert.throws(() => identLiteral("a-b"));
    assert.throws(() => identLiteral("my_token.aleo"));
    assert.throws(() => identLiteral("a".repeat(32)));
  });
});

describe("struct serializers", () => {
  it("serializes CreateStreamParams in declaration order and parses as Plaintext", () => {
    const text = createStreamParamsToPlaintext({
      receiver: RECEIVER,
      streamId: 42n,
      amount: 1_000_000n,
      startTime: 1_800_000_000n,
      duration: 3600n,
      isCancelable: true,
      isPausable: false,
      autoWithdrawable: true,
      withdrawFrequency: 60n,
      startNow: true,
      canTopup: false,
      initialBufferAmount: 0n,
    });
    assert.equal(
      text,
      `{ receiver: ${RECEIVER}, stream_id: 42field, amount: 1000000u128, ` +
      `start_time: 1800000000i64, duration: 3600u64, is_cancelable: true, ` +
      `is_pausable: false, auto_withdrawable: true, withdraw_frequency: 60u64, ` +
      `start_now: true, can_topup: false, initial_buffer_amount: 0u128 }`,
    );
    // Must parse with the real snarkVM plaintext parser.
    Plaintext.fromString(text).free();
  });

  it("serializes Config, StreamTokenFee, StreamAnchor and MerkleProofs as parseable Plaintext", () => {
    const config = configToPlaintext({
      configName: "7",
      admin: ADMIN,
      feeVault: ADMIN,
      withdrawer: ADMIN,
      baseFee: 1000n,
      platformFee: 2000n,
    });
    Plaintext.fromString(config).free();

    // StreamTokenFee: fields in Leo struct declaration order.
    const fee = streamTokenFeeToPlaintext({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.equal(
      fee,
      "{ config: 12345field, stream_token: 'token', stream_fee_amount: 50000u64, " +
      "expiry: 1893456000i64, nonce: 5field }",
    );
    Plaintext.fromString(fee).free();

    const anchor = streamAnchorToPlaintext(sampleAnchor());
    Plaintext.fromString(anchor).free();

    const proof = {
      siblings: Array.from({ length: 16 }, (_, i) => BigInt(i)),
      leafIndex: 3,
    };
    const proofs = merkleProofsToPlaintext([proof, proof]);
    assert.ok(proofs.startsWith("[") && proofs.endsWith("]"));
    assert.ok(merkleProofToPlaintext(proof).includes("leaf_index: 3u32"));
  });

  it("rejects MerkleProofs without exactly 16 siblings", () => {
    assert.throws(() => merkleProofToPlaintext({ siblings: [1n], leafIndex: 0 }));
  });

  it("serializes Payroll with member order matching the Leo struct declaration and parses as Plaintext", () => {
    const text = payrollToPlaintext(samplePayroll());
    assert.equal(
      text,
      `{ stream_id: 42field, config: 7field, sender: ${ADMIN}, receiver: ${RECEIVER}, ` +
      `full_amount: 1000000u128, token_program: 'token', is_cancelable: true, ` +
      `is_pausable: false, auto_withdrawable: true, can_topup: true, ` +
      `topup_count: 1u64, initialized: true }`,
    );
    Plaintext.fromString(text).free();
  });
});

function samplePayroll(): Payroll {
  return {
    streamId: "42field",
    config: "7field",
    sender: ADMIN,
    receiver: RECEIVER,
    fullAmount: 1_000_000n,
    tokenProgram: "token",
    isCancelable: true,
    isPausable: false,
    autoWithdrawable: true,
    canTopup: true,
    topupCount: 1n,
    initialized: true,
  };
}

function sampleAnchor(): StreamAnchor {
  return {
    streamId: "42field",
    startTime: 1_800_000_000n,
    duration: 3600n,
    paused: false,
    canceled: false,
    canceledAt: 0n,
    depositedAmount: 1_000_000n,
    coveredUntil: 0n,
    lastPausedTime: 0n,
    pausedInterval: 0n,
    withdrawnAmount: 500_000n,
    isPublic: false,
    createdTimestamp: 1_799_999_000n,
    initialized: true,
  };
}

describe("parsers", () => {
  it("round-trips a StreamAnchor through serialize/parse", () => {
    const anchor = sampleAnchor();
    assert.deepEqual(parseStreamAnchor(streamAnchorToPlaintext(anchor)), anchor);
  });

  it("parses multi-line mapping values as returned by the API", () => {
    const value = `{
  admin: ${ADMIN},
  fee_vault: ${RECEIVER},
  withdrawer: ${RECEIVER},
  base_fee: 1000u64,
  platform_fee: 2000u64,
  initialized: true
}`;
    assert.deepEqual(parsePayrollConfig(value), {
      admin: ADMIN,
      feeVault: RECEIVER,
      withdrawer: RECEIVER,
      baseFee: 1000n,
      platformFee: 2000n,
      initialized: true,
    });
  });

  it("parseStructMembers splits top-level members with nested arrays/structs", () => {
    const members = parseStructMembers(
      "{ a: [1field, 2field], b: { c: 1u8 }, d: true }",
    );
    assert.equal(members.get("a"), "[1field, 2field]");
    assert.equal(members.get("b"), "{ c: 1u8 }");
    assert.equal(members.get("d"), "true");
  });

  it("round-trips a Payroll through serialize/parse", () => {
    const payroll = samplePayroll();
    assert.deepEqual(parsePayroll(payrollToPlaintext(payroll)), payroll);
  });

  it("parses a Payroll mapping value with multi-line formatting", () => {
    const value = `{
      stream_id: 42field,
      config: 7field,
      sender: ${ADMIN},
      receiver: ${RECEIVER},
      full_amount: 1000000u128,
      token_program: 'token',
      is_cancelable: true,
      is_pausable: false,
      auto_withdrawable: true,
      can_topup: true,
      topup_count: 1u64,
      initialized: true
    }`;
    assert.deepEqual(parsePayroll(value), samplePayroll());
  });
});
