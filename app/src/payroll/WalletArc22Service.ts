/**
 * `WalletArc22Service` — wallet-backed counterpart of the Node
 * `Arc22Service` (sdk/client.ts). `approve` / `unapprove` are executed by the
 * Shield wallet (`executeTransaction`) against the IARC22 token program; the
 * view reads (`getAllowance`, `getBalanceOf`) run the token program's view
 * functions offline via a `ProgramManager` and parse the outputs.
 */

import { AleoKeyProvider, AleoNetworkClient, ProgramManager } from "@provablehq/sdk/testnet.js";

import { parseIntLiteral } from "../../../sdk/plaintext.ts";
import type { PayrollWallet } from "./WalletPayrollService.ts";

import { DEFAULT_FEE, HOST, TOKEN_PROGRAM_ID } from "../config.ts";

const TX_POLL_MS = 2_000;
const TX_TIMEOUT_MS = 600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WalletArc22Service {
  readonly wallet: PayrollWallet;
  readonly networkClient: AleoNetworkClient;
  readonly programManager: ProgramManager;
  readonly tokenProgramId: string;

  private readonly programSourceCache = new Map<string, string>();

  constructor(wallet: PayrollWallet, tokenProgramId: string = TOKEN_PROGRAM_ID) {
    this.wallet = wallet;
    this.tokenProgramId = tokenProgramId;
    this.networkClient = new AleoNetworkClient(HOST);
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    this.programManager = new ProgramManager(HOST, keyProvider);
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
  // View reads (offline `run`, no broadcast)
  // =======================================================================

  /** On-chain `allowance(owner, spender) -> u128`. */
  async getAllowance(owner: string, spender: string): Promise<bigint> {
    const output = await this.viewRead("allowance", [owner, spender]);
    return parseIntLiteral(output);
  }

  /** On-chain `balance_of(account) -> u128`. */
  async getBalanceOf(account: string): Promise<bigint> {
    const output = await this.viewRead("balance_of", [account]);
    return parseIntLiteral(output);
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

  private async viewRead(functionName: string, inputs: string[]): Promise<string> {
    const source = await this.loadProgramSource(this.tokenProgramId);
    const output = await this.programManager.execute({
      program: source,
      programName: this.tokenProgramId,
      functionName, inputs,
      privateFee: false,
      priorityFee: 0
    });
    return output
  }

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

  private async loadProgramSource(programId: string): Promise<string> {
    const cached = this.programSourceCache.get(programId);
    if (cached !== undefined) return cached;
    const source = await this.networkClient.getProgram(programId);
    this.programSourceCache.set(programId, source);
    return source;
  }
}
