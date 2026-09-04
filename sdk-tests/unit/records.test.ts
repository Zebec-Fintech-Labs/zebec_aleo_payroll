/**
 * Record-plaintext helpers. `recordAmount` sizes the `credit_input_record` and
 * `token_input_record` inputs of `create_stream_private`, so an amount read
 * off the wrong member produces a record that fails the on-chain coverage
 * asserts during proving.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import { matchesTicketRecord, recordAmount } from "../../sdk/records.js";

const OWNER = "aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4";

const creditsRecord = `{ owner: ${OWNER}.private, microcredits: 1500000u64.private, _nonce: 1group.public }`;
const tokenRecord = `{ owner: ${OWNER}.private, amount: 2000000u128.private, _nonce: 2group.public }`;

describe("recordAmount", () => {
  it("reads the credits and token amount members", () => {
    assert.equal(recordAmount(creditsRecord, "microcredits"), 1_500_000n);
    assert.equal(recordAmount(tokenRecord, "amount"), 2_000_000n);
  });

  it("returns undefined when the member is absent", () => {
    assert.equal(recordAmount(creditsRecord, "amount"), undefined);
    assert.equal(recordAmount(tokenRecord, "microcredits"), undefined);
    assert.equal(recordAmount("", "amount"), undefined);
  });

  it("reads across multi-line plaintexts", () => {
    assert.equal(recordAmount(`{\n  amount:  42u128.private\n}`, "amount"), 42n);
  });

  it("only accepts the u64/u128 widths records actually use", () => {
    assert.equal(recordAmount("{ amount: 42u32 }", "amount"), undefined);
    assert.equal(recordAmount("{ amount: 42field }", "amount"), undefined);
  });

  it("matches a member name as a substring of a longer member", () => {
    // `full_amount: 5u128` contains `amount: 5u128`, so a ticket record read
    // with member `amount` yields the stream's full amount. `isTokenRecord`
    // in client.ts filters ticket records out before this is ever called —
    // any new caller must do the same.
    assert.equal(recordAmount("{ full_amount: 5u128 }", "amount"), 5n);
  });
});

describe("matchesTicketRecord (re-exported for record scans)", () => {
  const ticket = (type: number) => `{ owner: ${OWNER}.private, ticket_type: ${type}u8.private, stream_id: 1field.private }`;

  it("distinguishes the three ticket types", () => {
    assert.equal(matchesTicketRecord(ticket(0), "SenderStreamTicket"), true);
    assert.equal(matchesTicketRecord(ticket(1), "ReceiverStreamTicket"), true);
    assert.equal(matchesTicketRecord(ticket(2), "WithdrawerStreamTicket"), true);
    assert.equal(matchesTicketRecord(ticket(1), "SenderStreamTicket"), false);
  });

  it("does not match token or credits records", () => {
    assert.equal(matchesTicketRecord(tokenRecord, "SenderStreamTicket"), false);
    assert.equal(matchesTicketRecord(creditsRecord, "ReceiverStreamTicket"), false);
  });
});
