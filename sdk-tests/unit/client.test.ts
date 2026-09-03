import assert from "node:assert";
import { describe, it } from "mocha";

import { StreamService as StreamClient, PROGRAM_ID } from "../../sdk/client.js";
import { Network } from "../../sdk/config.js";
import type { AleoWallet, TransactionOptions } from "../../sdk/types.js";

const WALLET_ADDRESS = "aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4";
const OTHER_ADDRESS = "aleo129nrpl0dxh4evdsan3f4lyhz5pdgp6klrn5atp37ejlavswx5czsk0j5dj";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

interface MockWallet extends AleoWallet {
  txCalls: TransactionOptions[];
}

type MockRecord = { text: string; spent?: boolean };

/**
 * Mock wallet: record "ciphertexts" are JSON-encoded plaintexts and
 * `executeTransaction` just records its options.
 */
function makeWallet(records: Record<string, MockRecord[]>, txId = "at1mock"): MockWallet {
  const txCalls: TransactionOptions[] = [];
  return {
    address: WALLET_ADDRESS,
    txCalls,
    decrypt: async (cipherText) => JSON.parse(cipherText) as string,
    requestRecords: async (program) =>
      (records[program] ?? []).map((r) => ({
        spent: r.spent ?? false,
        recordCiphertext: JSON.stringify(r.text),
      })),
    executeTransaction: async (options) => {
      txCalls.push(options);
      return { transactionId: txId };
    },
  };
}

function creditRecord(microcredits: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    microcredits: ${microcredits}u64.private,
    _nonce: 111group.public,
    _version: 1u8.public
  }`;
}

function tokenRecord(amount: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    amount: ${amount}u128.private,
    _nonce: 222group.public,
    _version: 1u8.public
  }`;
}

function senderTicket(streamId: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    ticket_type: 0u8.private,
    config: 7field.private,
    stream_id: ${streamId}field.private,
    receiver: ${OTHER_ADDRESS}.private,
    token_program: 'test_token'.private,
    full_amount: 1000000u128.private,
    is_cancelable: true.private,
    is_pausable: false.private,
    can_topup: true.private,
    topup_count: 1u64.private,
    _nonce: 333group.public,
    _version: 1u8.public
  }`;
}

function receiverTicket(streamId: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    ticket_type: 1u8.private,
    config: 7field.private,
    sender: ${OTHER_ADDRESS}.private,
    token_program: 'test_token'.private,
    full_amount: 1000000u128.private,
    auto_withdrawable: true.private,
    stream_id: ${streamId}field.private,
    _nonce: 444group.public,
    _version: 1u8.public
  }`;
}

describe("StreamClient — construction", () => {
  it("exposes the wallet address and default program id", () => {
    const client = new StreamClient(makeWallet({}));
    assert.equal(client.address, WALLET_ADDRESS);
    assert.equal(client.programId, PROGRAM_ID);
    assert.equal(client.network, Network.TESTNET);
  });

  it("requires an explicit programId on networks without a default", () => {
    assert.throws(
      () => new StreamClient(makeWallet({}), { network: Network.MAINNET }),
      /no default stream program id/,
    );
  });
});

describe("StreamClient — wallet execution", () => {
  it("executes with the default fee and program", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    const txId = await client.pauseResumeStreamPublic({ streamId: 42n });
    assert.equal(txId, "at1mock");
    const call = wallet.txCalls[0]!;
    assert.equal(call.program, PROGRAM_ID);
    assert.equal(call.function, "pause_resume_stream_public");
    assert.deepEqual(call.inputs, ["42field"]);
    assert.equal(call.fee, 100_000); // default priority fee, in microcredits
  });

  it("passes fee options and imports through to the wallet", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.pauseResumeStreamPublic(
      { streamId: 42n },
      {
        priorityFee: 250_000,
        privateFee: true,
        feeRecord: "{ owner: record... }",
        imports: ["credits.aleo"],
      },
    );
    const call = wallet.txCalls[0]!;
    assert.equal(call.fee, 250_000);
    assert.equal(call.privateFee, true);
    assert.equal(call.feeRecord, "{ owner: record... }");
    assert.deepEqual(call.imports, ["credits.aleo"]);
  });

  it("throws when the wallet returns no transaction id", async () => {
    const client = new StreamClient(makeWallet({}, ""));
    await assert.rejects(
      client.pauseResumeStreamPublic({ streamId: 42n }),
      /did not return a transaction id/,
    );
  });

  it("approveTokenPublic converts human amounts to micro units", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.approveTokenPublic(
      "test_token",
      "aleo1aprgaddress0spender0000000000000000000000000000000000000000",
      "2.5",
      6,
      { imports: ["test_token.aleo"] },
    );
    const call = wallet.txCalls[0]!;
    assert.equal(call.program, "test_token.aleo");
    assert.equal(call.function, "approve_public");
    assert.deepEqual(call.inputs[1], "2500000u128");
  });

  it("initializeConfig converts human fees to microcredits", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.initializeConfig({
      configName: 7n,
      admin: WALLET_ADDRESS,
      feeVault: WALLET_ADDRESS,
      withdrawer: WALLET_ADDRESS,
      baseFee: "0.01",
      platformFee: "0.1",
    });
    const call = wallet.txCalls[0]!;
    assert.equal(call.function, "initialize_config");
    assert.deepEqual(call.inputs, [
      "7field",
      WALLET_ADDRESS,
      WALLET_ADDRESS,
      "10000u64",
      "100000u64",
    ]);
  });

  it("rejects self-streams before touching the network", async () => {
    const client = new StreamClient(makeWallet({}));
    await assert.rejects(
      client.createStreamPublic(
        {
          receiver: WALLET_ADDRESS,
          streamId: 1n,
          amount: "1",
          startTime: 0,
          duration: 60,
          isCancelable: true,
          isPausable: true,
          autoWithdrawable: false,
          withdrawFrequency: 0,
          startNow: true,
          canTopup: false,
          initialBufferAmount: "0",
        },
        "test_token",
        6,
        {
          configName: 7n,
          admin: WALLET_ADDRESS,
          feeVault: WALLET_ADDRESS,
          withdrawer: WALLET_ADDRESS,
          baseFee: "0.01",
          platformFee: "0.1",
        },
        { config: 7n, streamToken: "test_token", streamFeeAmount: "0.1", expiry: 0, nonce: 1n },
        "sign1mock",
      ),
      /cannot create a stream to yourself/,
    );
  });
});

describe("StreamClient — records via wallet", () => {
  it("findCredits picks the highest covering record and skips spent ones", async () => {
    const small = creditRecord(500_000n);
    const mid = creditRecord(5_000_000n);
    const high = creditRecord(10_000_000n);
    const wallet = makeWallet({
      "credits.aleo": [{ text: mid }, { text: high, spent: true }, { text: small }],
    });
    const client = new StreamClient(wallet);
    const found = await client.findCredits(1_000_000n);
    assert.equal(found, norm(mid));
    await assert.rejects(client.findCredits(100_000_000n), /no unspent credits/);
  });

  it("findTokenRecords returns covering records highest-first", async () => {
    const tokenProgramId = "test_token.aleo";
    const low = tokenRecord(2_000_000n);
    const high = tokenRecord(8_000_000n);
    const wallet = makeWallet({
      [tokenProgramId]: [{ text: low }, { text: high }],
    });
    const client = new StreamClient(wallet);
    assert.deepEqual(await client.findTokenRecords(tokenProgramId, 1_000_000n), [
      norm(high),
      norm(low),
    ]);
    assert.equal(await client.findToken(tokenProgramId, 1_000_000n), norm(high));
    await assert.rejects(
      client.findToken(tokenProgramId, 9_000_000n),
      /no unspent token record/,
    );
  });

  it("findToken ignores ticket-like records", async () => {
    const tokenProgramId = "test_token.aleo";
    const wallet = makeWallet({
      [tokenProgramId]: [{ text: senderTicket(111n) }],
    });
    const client = new StreamClient(wallet);
    await assert.rejects(client.findToken(tokenProgramId, 1n), /no unspent token record/);
  });

  it("findTicket matches ticket_type and stream id", async () => {
    const sender = senderTicket(111n);
    const wallet = makeWallet({
      [PROGRAM_ID]: [{ text: receiverTicket(111n) }, { text: sender }, { text: senderTicket(222n) }],
    });
    const client = new StreamClient(wallet);
    assert.equal(await client.findTicket(0, 111n), norm(sender));
    assert.equal(await client.findTicket(1, 111n), norm(receiverTicket(111n)));
    await assert.rejects(
      client.findTicket(2, 111n),
      /no unspent stream ticket found for stream 111/,
    );
  });
});
