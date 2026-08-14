/**
 * `WalletArc22Service` — wallet-backed counterpart of the Node
 * `Arc22Service` (sdk/client.ts). `approve` / `unapprove` are executed by the
 * Shield wallet (`executeTransaction`) against the IARC22 token program; the
 * reads (`getAllowance`, `getBalanceOf`) query the token program's mappings
 * directly via an `AleoNetworkClient`.
 */

import { AleoNetworkClient } from "@provablehq/sdk/testnet.js";

import { tokenAllowanceKey } from "../../../sdk/hashing.ts";
import { parseIntLiteral } from "../../../sdk/plaintext.ts";
import type { PayrollWallet } from "./WalletPayrollService.ts";

import { DEFAULT_FEE, HOST, TOKEN_PROGRAM_ID } from "../config.ts";

const TX_POLL_MS = 2_000;
const TX_TIMEOUT_MS = 600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WalletArc22Service {
  readonly wallet: PayrollWallet;
  readonly networkClient: AleoNetworkClient;
  readonly tokenProgramId: string;

  constructor(wallet: PayrollWallet, tokenProgramId: string = TOKEN_PROGRAM_ID) {
    this.wallet = wallet;
    this.tokenProgramId = tokenProgramId;
    this.networkClient = new AleoNetworkClient(HOST);
  }

  get address(): string {
    return this.wallet.address;
  }

  // =======================================================================
  // Mutating entry points
  // =======================================================================

  /** Approve `spender` to spend `amount` (u128) of the caller's tokens. */
  async approve(
    spender: string,
    amount: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    return this.execute("approve_public", [spender, `${amount}u128`], fee);
  }

  /** Revoke `amount` (u128) of an existing allowance granted to `spender`. */
  async unapprove(
    spender: string,
    amount: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    return this.execute("unapprove_public", [spender, `${amount}u128`], fee);
  }

  // =======================================================================
  // Mapping reads (direct chain queries, no offline program execution)
  // =======================================================================

  /**
   * On-chain `allowance(owner, spender) -> u128`, read from the IARC22
   * `allowances` mapping. The mapping key is `hash.bhp256(TokenAllowance {
   * account: owner, spender })`. Returns `0n` when the key is absent.
   */
  async getAllowance(owner: string, spender: string): Promise<bigint> {
    const key = tokenAllowanceKey(owner, spender);
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.tokenProgramId,
        "allowances",
        key,
      );
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  /**
   * On-chain `balance_of(account) -> u128`, read from the IARC22 `balances`
   * mapping (falling back to `account` if `balances` is absent). Returns `0n`
   * when the account has no balance entry.
   */
  async getBalanceOf(account: string): Promise<bigint> {
    const mappingNames = await this.networkClient.getProgramMappingNames(
      this.tokenProgramId,
    );
    const balanceMappingName = mappingNames.includes("balances")
      ? "balances"
      : mappingNames.includes("account")
        ? "account"
        : null;
    if (!balanceMappingName) {
      throw new Error("No public balance mapping found (no 'balances' or 'account').");
    }
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.tokenProgramId,
        balanceMappingName,
        account,
      );
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  // =======================================================================
  // Transaction confirmation
  // =======================================================================

  /**
   * Poll the wallet's `transactionStatus` until the transaction is accepted
   * or fails (~10 min timeout). Falls back to the network client when the
   * wallet's status method errors.
   */
  async waitForConfirmation(txId: string): Promise<void> {
    const deadline = Date.now() + TX_TIMEOUT_MS;
    let walletStatusBroken = false;
    while (Date.now() < deadline) {
      let status: string;
      try {
        status = (await this.wallet.transactionStatus(txId)).status;
      } catch {
        walletStatusBroken = true;
        break;
      }
      const s = status.toLowerCase();
      if (["accepted", "confirmed", "completed", "finalized"].includes(s)) return;
      if (["failed", "rejected", "aborted"].includes(s)) {
        throw new Error(`Transaction ${txId} failed with status: ${status}`);
      }
      await sleep(TX_POLL_MS);
    }
    if (!walletStatusBroken) {
      throw new Error(`timed out waiting for transaction ${txId}`);
    }
    const confirmation = await this.networkClient.waitForTransactionConfirmation(
      txId,
      TX_POLL_MS,
      TX_TIMEOUT_MS,
    );
    if (confirmation.status.toLowerCase() !== "accepted") {
      throw new Error(`Transaction ${txId} failed with status: ${confirmation.status}`);
    }
  }

  // =======================================================================
  // Internals
  // =======================================================================

  private async execute(
    functionName: string,
    inputs: string[],
    fee: number,
  ): Promise<string> {
    const result = await this.wallet.executeTransaction({
      program: this.tokenProgramId,
      function: functionName,
      inputs,
      fee,
      privateFee: false,
    });
    if (result === undefined || result.transactionId === "") {
      throw new Error("wallet did not return a transaction id (rejected?)");
    }
    return result.transactionId;
  }
}
