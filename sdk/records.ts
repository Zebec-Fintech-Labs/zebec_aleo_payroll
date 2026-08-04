/**
 * Helpers for locating unspent records needed by `aacs_payroll.aleo`
 * transitions: `credits.aleo` records for fees, IARC22 token records for
 * stream deposits, and payroll ticket records for stream management.
 */

import type { AleoNetworkClient, RecordPlaintext } from "@provablehq/sdk";

const CREDITS_PROGRAM = "credits.aleo";

async function findRecords(
  networkClient: AleoNetworkClient,
  privateKey: string,
  programs: string[],
): Promise<RecordPlaintext[]> {
  return networkClient.findUnspentRecords(
    0,
    undefined,
    programs,
    undefined,
    undefined,
    undefined,
    privateKey,
  );
}

function recordAmount(record: RecordPlaintext, member: string): bigint | undefined {
  const match = new RegExp(`${member}:\\s*(\\d+)(?:u64|u128)`).exec(record.toString());
  return match ? BigInt(match[1]!) : undefined;
}

/**
 * Find an unspent `credits.aleo` record with at least `minMicrocredits`.
 * Used for the `credit_input_record` of `create_stream_private` (and as a
 * fee record when paying fees privately).
 */
export async function findCreditsRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  minMicrocredits: bigint,
): Promise<RecordPlaintext> {
  const records = await findRecords(networkClient, privateKey, [CREDITS_PROGRAM]);
  for (const record of records) {
    const microcredits = recordAmount(record, "microcredits");
    if (microcredits !== undefined && microcredits >= minMicrocredits) {
      return record;
    }
  }
  throw new Error(
    `no unspent credits.aleo record with at least ${minMicrocredits} microcredits`,
  );
}

/**
 * Find an unspent token record of the given IARC22 token program with at
 * least `minAmount`. Used for the `token_input_record` of
 * `create_stream_private`.
 */
export async function findTokenRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  tokenProgramId: string,
  minAmount: bigint,
): Promise<RecordPlaintext> {
  const records = await findRecords(networkClient, privateKey, [tokenProgramId]);
  for (const record of records) {
    if (!record.toString().includes("owner:")) continue;
    const amount = recordAmount(record, "amount");
    if (amount !== undefined && amount >= minAmount) {
      return record;
    }
  }
  throw new Error(
    `no unspent token record in ${tokenProgramId} with at least ${minAmount}`,
  );
}

export type TicketRecordName =
  | "SenderPayrollTicket"
  | "ReceiverPayrollTicket"
  | "WithdrawerPayrollTicket";

/**
 * Record plaintexts do not carry the record name, so the three payroll
 * tickets are told apart structurally (see `main.leo`):
 * - `SenderPayrollTicket` is the only one with `is_cancelable`;
 * - `WithdrawerPayrollTicket` is the only one with both `sender` and
 *   `receiver` members;
 * - `ReceiverPayrollTicket` has `sender` but no `receiver`.
 */
function matchesTicket(text: string, recordName: TicketRecordName): boolean {
  const has = (member: string) => new RegExp(`${member}:`).test(text);
  switch (recordName) {
    case "SenderPayrollTicket":
      return has("is_cancelable");
    case "WithdrawerPayrollTicket":
      return has("sender") && has("receiver");
    case "ReceiverPayrollTicket":
      return has("sender") && !has("receiver") && !has("is_cancelable");
  }
}

/**
 * Find the unspent payroll ticket record of `recordName` for `streamId`
 * owned by the account behind `privateKey`. Throws if not found.
 */
export async function findTicketRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  programId: string,
  recordName: TicketRecordName,
  streamId: string | bigint,
): Promise<RecordPlaintext> {
  const records = await findRecords(networkClient, privateKey, [programId]);
  const idDigits = streamId.toString().replace(/field$/, "");
  for (const record of records) {
    const text = record.toString();
    if (!matchesTicket(text, recordName)) continue;
    if (new RegExp(`stream_id:\\s*${idDigits}field`).test(text)) {
      return record;
    }
  }
  throw new Error(`no ${recordName} record found for stream ${idDigits}`);
}
