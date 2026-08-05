/**
 * Helpers for locating unspent records needed by `aacs_payroll_v2.aleo`
 * transitions: `credits.aleo` records for fees, IARC22 token records for
 * stream deposits, and payroll ticket records for stream management.
 */

import type { AleoNetworkClient, RecordPlaintext } from "@provablehq/sdk";

const CREDITS_PROGRAM = "credits.aleo";

/**
 * `AleoNetworkClient.findUnspentRecords` walks the chain backwards in
 * 50-block HTTP requests. On a failed request it retries the same chunk up
 * to 10 times *without any delay* and then silently returns the records
 * collected so far, and the explorer API regularly answers with transient
 * 5xx errors or 429 rate limits. The scan is therefore driven here in
 * small windows that are retried with backoff and paced, and it stops as
 * soon as a matching record is found.
 */
const SCAN_WINDOW_BLOCKS = 500;
const SCAN_MAX_ATTEMPTS = 5;
const SCAN_BASE_DELAY_MS = 1_000;
const SCAN_WINDOW_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry `fn` with exponential backoff against transient explorer errors. */
async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCAN_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < SCAN_MAX_ATTEMPTS) {
        const backoff = SCAN_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(backoff + Math.floor(Math.random() * backoff));
      }
    }
  }
  throw lastError;
}

export interface RecordScanOptions {
  /**
   * Do not scan below this block height (defaults to 0, i.e. full history).
   * Set it (e.g. to `latestHeight - 100_000`) only when every record of
   * interest is known to be younger than that bound.
   */
  minHeight?: number;
}

/**
 * Scan the chain backwards from the latest block, window by window, and
 * return the first (i.e. newest) unspent record of `programs` owned by the
 * account behind `privateKey` that satisfies `match`. Returns `undefined`
 * when the whole range down to `options.minHeight` was scanned without a
 * match.
 */
async function scanForRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  programs: string[],
  match: (record: RecordPlaintext) => boolean,
  options: RecordScanOptions = {},
): Promise<RecordPlaintext | undefined> {
  const floor = options.minHeight ?? 0;
  let end = await withRetries(() => networkClient.getLatestHeight());
  // Nonces of records already collected, so retried windows skip them.
  const nonces: string[] = [];
  while (end > floor) {
    const start = Math.max(floor, end - SCAN_WINDOW_BLOCKS);
    const records = await withRetries(() =>
      networkClient.findUnspentRecords(
        start,
        end,
        programs,
        undefined,
        undefined,
        nonces,
        privateKey,
      ),
    );
    for (const record of records) {
      nonces.push(record.nonce());
      if (match(record)) return record;
    }
    end = start;
    // Pace the windows: the public explorer rate-limits aggressive scans.
    if (end > floor) await sleep(SCAN_WINDOW_DELAY_MS);
  }
  return undefined;
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
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [CREDITS_PROGRAM],
    (candidate) => {
      const microcredits = recordAmount(candidate, "microcredits");
      return microcredits !== undefined && microcredits >= minMicrocredits;
    },
    options,
  );
  if (record === undefined) {
    throw new Error(
      `no unspent credits.aleo record with at least ${minMicrocredits} microcredits`,
    );
  }
  return record;
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
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [tokenProgramId],
    (candidate) => {
      if (!candidate.toString().includes("owner:")) return false;
      const amount = recordAmount(candidate, "amount");
      return amount !== undefined && amount >= minAmount;
    },
    options,
  );
  if (record === undefined) {
    throw new Error(
      `no unspent token record in ${tokenProgramId} with at least ${minAmount}`,
    );
  }
  return record;
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
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const idDigits = streamId.toString().replace(/field$/, "");
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [programId],
    (candidate) => {
      const text = candidate.toString();
      return (
        matchesTicket(text, recordName) &&
        new RegExp(`stream_id:\\s*${idDigits}field`).test(text)
      );
    },
    options,
  );
  if (record === undefined) {
    throw new Error(`no ${recordName} record found for stream ${idDigits}`);
  }
  return record;
}
