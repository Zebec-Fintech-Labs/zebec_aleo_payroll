# Public Stream App Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add create/pause-resume/cancel/withdraw support for **public** payroll streams to the web app (`app/`), mirroring the private-stream support that already exists, while accounting for the two structural differences public streams have (no ticket records; deposit requires a prior `approve_public`).

**Architecture:** Extend the shared SDK codec layer (`sdk/types.ts`, `sdk/plaintext.ts`) with a `Payroll` struct mirror, add the four public-stream transitions plus a mapping read to `WalletPayrollService`, add a tiny localStorage-backed "known stream ids" store (since public streams have no wallet records to enumerate), and add one new UI tab (`PublicStreamPage.tsx`) wired into `App.tsx`.

**Tech Stack:** TypeScript, React 18 (Vite, no test framework in `app/`), Mocha/`node:assert` for SDK unit tests (`sdk-tests/unit/`), `@provablehq/sdk` / `@provablehq/wasm` for Leo plaintext/address handling.

## Global Constraints

- Struct plaintext serializers **must** emit members in the exact Leo declaration order (see the file header comment in `sdk/plaintext.ts`) — this is required for `BHP256::hash_to_field` / on-chain plaintext parity, not just style.
- `Payroll` struct declaration order (from `src/main.leo`): `stream_id, config, sender, receiver, full_amount, token_program, is_cancelable, is_pausable, auto_withdrawable, can_topup, topup_count, initialized`.
- No top-up support for public streams — there is no `topup_stream_public` transition in `src/main.leo`. Do not add one.
- The app has no automated UI test harness. Verification for `app/` changes is `npx tsc --noEmit` (typecheck) run from `app/`, plus a full `npx vite build` at the end. **On this Windows environment, run these via `npx` directly, not `npm run build`** — `npm run sdk:test:unit`/`npm run build` invoke scripts through `cmd.exe`, which mangles the single-quoted glob in the sdk unit-test script; `npx`-based commands avoid that.
- SDK unit tests live in `sdk-tests/unit/*.test.ts`, run (from the repo root) with:
  ```
  npx tsc -p tsconfig.test.json && npx mocha .test-dist/sdk-tests/unit/**/*.test.js
  ```
- Follow existing code conventions exactly: `WalletPayrollService` methods return a submitted transaction id and let the caller await confirmation (except where a prerequisite transaction's confirmation must be awaited internally, as documented per-method below); UI pages use the `UsePayroll` (`busy`/`runTx`/`service`/`address`) plumbing from `app/src/hooks/usePayroll.ts` unchanged.
- Spec: `docs/superpowers/specs/2026-08-13-public-stream-app-features-design.md`.

---

### Task 1: SDK — `Payroll` struct type, plaintext codec, and unit tests

**Files:**
- Modify: `sdk/types.ts`
- Modify: `sdk/plaintext.ts`
- Test: `sdk-tests/unit/plaintext.test.ts`

**Interfaces:**
- Produces: `Payroll` interface (`sdk/types.ts`), `payrollToPlaintext(p: Payroll): string`, `parsePayroll(plaintext: string): Payroll`, `parseIdentLiteral(value: string): string` (`sdk/plaintext.ts`) — all used by Task 2's `getPublicPayroll` and Task 3/4's public-stream methods.

- [ ] **Step 1: Write the failing tests**

  Edit `sdk-tests/unit/plaintext.test.ts`. Replace the existing import block:

  ```ts
  import {
    configToPlaintext,
    createStreamParamsToPlaintext,
    fieldLiteral,
    identLiteral,
    merkleProofToPlaintext,
    merkleProofsToPlaintext,
    parseFeeTier,
    parsePayrollConfig,
    parseStreamAnchor,
    parseStructMembers,
    streamAnchorToPlaintext,
    tokenPriceToPlaintext,
  } from "../../sdk/plaintext.js";
  import type { StreamAnchor } from "../../sdk/types.js";
  ```

  with:

  ```ts
  import {
    configToPlaintext,
    createStreamParamsToPlaintext,
    fieldLiteral,
    identLiteral,
    merkleProofToPlaintext,
    merkleProofsToPlaintext,
    parseFeeTier,
    parseIdentLiteral,
    parsePayroll,
    parsePayrollConfig,
    parseStreamAnchor,
    parseStructMembers,
    payrollToPlaintext,
    streamAnchorToPlaintext,
    tokenPriceToPlaintext,
  } from "../../sdk/plaintext.js";
  import type { Payroll, StreamAnchor } from "../../sdk/types.js";
  ```

  Add a `samplePayroll()` helper right after the existing `sampleAnchor()` function:

  ```ts
  function samplePayroll(): Payroll {
    return {
      streamId: "42field",
      config: "7field",
      sender: ADMIN,
      receiver: RECEIVER,
      fullAmount: 1_000_000n,
      tokenProgram: "test_usdcx_stablecoin",
      isCancelable: true,
      isPausable: true,
      autoWithdrawable: false,
      canTopup: false,
      topupCount: 0n,
      initialized: true,
    };
  }
  ```

  Add a new test inside the existing `describe("struct serializers", ...)` block (as another `it(...)`, alongside the existing ones):

  ```ts
    it("serializes a Payroll struct in declaration order and parses as Plaintext", () => {
      const text = payrollToPlaintext(samplePayroll());
      assert.equal(
        text,
        `{ stream_id: 42field, config: 7field, sender: ${ADMIN}, ` +
        `receiver: ${RECEIVER}, full_amount: 1000000u128, ` +
        `token_program: 'test_usdcx_stablecoin', is_cancelable: true, ` +
        `is_pausable: true, auto_withdrawable: false, can_topup: false, ` +
        `topup_count: 0u64, initialized: true }`,
      );
      Plaintext.fromString(text).free();
    });
  ```

  Add a new `describe` block for `parseIdentLiteral`, right after the existing `describe("identLiteral", ...)` block:

  ```ts
  describe("parseIdentLiteral", () => {
    it("unwraps a quoted identifier literal", () => {
      assert.equal(parseIdentLiteral("'my_token'"), "my_token");
    });
    it("rejects a non-identifier literal", () => {
      assert.throws(() => parseIdentLiteral("my_token"));
      assert.throws(() => parseIdentLiteral("'a-b'"));
    });
  });
  ```

  Add two new tests inside the existing `describe("parsers", ...)` block (alongside the existing ones):

  ```ts
    it("round-trips a Payroll through serialize/parse", () => {
      const payroll = samplePayroll();
      assert.deepEqual(parsePayroll(payrollToPlaintext(payroll)), payroll);
    });

    it("parses a multi-line Payroll mapping value as returned by the API", () => {
      const value = `{
    stream_id: 42field,
    config: 7field,
    sender: ${ADMIN},
    receiver: ${RECEIVER},
    full_amount: 1000000u128,
    token_program: 'test_usdcx_stablecoin',
    is_cancelable: true,
    is_pausable: true,
    auto_withdrawable: false,
    can_topup: false,
    topup_count: 0u64,
    initialized: true
  }`;
      assert.deepEqual(parsePayroll(value), samplePayroll());
    });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  From the repo root:
  ```
  npx tsc -p tsconfig.test.json && npx mocha .test-dist/sdk-tests/unit/**/*.test.js
  ```
  Expected: the `tsc` step FAILS with errors like `Module '"../../sdk/plaintext.js"' has no exported member 'payrollToPlaintext'` (and `parsePayroll`, `parseIdentLiteral`), and `Module '"../../sdk/types.js"' has no exported member 'Payroll'`.

- [ ] **Step 3: Add the `Payroll` interface to `sdk/types.ts`**

  Insert immediately after the `PayrollConfig` interface (before the `StreamAnchor` interface), matching `src/main.leo`'s struct declaration order (`Payroll` is declared there before `StreamAnchor`):

  ```ts
  /** Leo `Payroll` struct, as stored in the `payrolls` mapping (public streams only). */
  export interface Payroll {
    streamId: string;
    /** Config (tenant) the stream was created under. */
    config: string;
    sender: string;
    receiver: string;
    fullAmount: bigint;
    tokenProgram: string;
    isCancelable: boolean;
    isPausable: boolean;
    autoWithdrawable: boolean;
    canTopup: boolean;
    topupCount: bigint;
    initialized: boolean;
  }
  ```

- [ ] **Step 4: Add the codec functions to `sdk/plaintext.ts`**

  Add `Payroll` to the type-only import at the top of the file. Change:
  ```ts
  import type {
    Config,
    CreateStreamParams,
    FeeTier,
    MerkleProof,
    PayrollConfig,
    StreamAnchor,
    TokenPrice,
  } from "./types.js";
  ```
  to:
  ```ts
  import type {
    Config,
    CreateStreamParams,
    FeeTier,
    MerkleProof,
    Payroll,
    PayrollConfig,
    StreamAnchor,
    TokenPrice,
  } from "./types.js";
  ```

  Add `payrollToPlaintext` right after `tokenPriceToPlaintext` and before `streamAnchorToPlaintext`:

  ```ts
  /** Serialize a `Payroll` struct to its Leo plaintext literal. */
  export function payrollToPlaintext(p: Payroll): string {
    return validated(
      `{ stream_id: ${fieldLiteral(p.streamId)}, config: ${fieldLiteral(p.config)}, ` +
      `sender: ${p.sender}, receiver: ${p.receiver}, ` +
      `full_amount: ${p.fullAmount}u128, token_program: ${identLiteral(p.tokenProgram)}, ` +
      `is_cancelable: ${boolLiteral(p.isCancelable)}, is_pausable: ${boolLiteral(p.isPausable)}, ` +
      `auto_withdrawable: ${boolLiteral(p.autoWithdrawable)}, can_topup: ${boolLiteral(p.canTopup)}, ` +
      `topup_count: ${p.topupCount}u64, initialized: ${boolLiteral(p.initialized)} }`
    );
  }
  ```

  Add `parseIdentLiteral` right after `parseBoolLiteral` and before `parseFieldLiteral`:

  ```ts
  /** Parse an identifier literal (`"'my_token'"`) to its bare form (`"my_token"`). */
  export function parseIdentLiteral(value: string): string {
    const v = value.trim();
    const m = /^'([a-z][a-z0-9_]{0,30})'$/.exec(v);
    if (!m) throw new Error(`not an identifier literal: ${value}`);
    return m[1]!;
  }
  ```

  Add `parsePayroll` right after `parseFieldLiteral` and before `parseStreamAnchor` (matching the Payroll-before-StreamAnchor declaration order used elsewhere in this file):

  ```ts
  /** Parse a `Payroll` mapping value. */
  export function parsePayroll(plaintext: string): Payroll {
    if (!plaintext) {
      throw new Error("value is empty: " + plaintext);
    }
    const m = parseStructMembers(plaintext);
    return {
      streamId: parseFieldLiteral(requireMember(m, "stream_id")),
      config: parseFieldLiteral(requireMember(m, "config")),
      sender: requireMember(m, "sender"),
      receiver: requireMember(m, "receiver"),
      fullAmount: parseIntLiteral(requireMember(m, "full_amount")),
      tokenProgram: parseIdentLiteral(requireMember(m, "token_program")),
      isCancelable: parseBoolLiteral(requireMember(m, "is_cancelable")),
      isPausable: parseBoolLiteral(requireMember(m, "is_pausable")),
      autoWithdrawable: parseBoolLiteral(requireMember(m, "auto_withdrawable")),
      canTopup: parseBoolLiteral(requireMember(m, "can_topup")),
      topupCount: parseIntLiteral(requireMember(m, "topup_count")),
      initialized: parseBoolLiteral(requireMember(m, "initialized")),
    };
  }
  ```

- [ ] **Step 5: Run tests to verify they pass**

  From the repo root:
  ```
  npx tsc -p tsconfig.test.json && npx mocha .test-dist/sdk-tests/unit/**/*.test.js
  ```
  Expected: all tests PASS (30 existing + 5 new = 35 passing), no failures.

- [ ] **Step 6: Commit**

  ```bash
  git add sdk/types.ts sdk/plaintext.ts sdk-tests/unit/plaintext.test.ts
  git commit -m "feat(sdk): add Payroll struct codec for public streams"
  ```

---

### Task 2: `WalletPayrollService` — generalize `execute()`, add `getProgramAddress()` and `getPublicPayroll()`

**Files:**
- Modify: `app/src/payroll/WalletPayrollService.ts`

**Interfaces:**
- Consumes: `Payroll`, `parsePayroll` from Task 1.
- Produces: `execute(program, functionName, inputs, fee, imports?)` (now takes a `program` first argument — every existing call site must be updated in this same task or the file won't compile), `getProgramAddress(): string`, `getPublicPayroll(streamId: string | bigint): Promise<Payroll>`. Task 3/4 call all three.

- [ ] **Step 1: Update imports**

  Change:
  ```ts
  import { AleoNetworkClient, SealanceMerkleTree } from "@provablehq/sdk/testnet.js";
  ```
  to:
  ```ts
  import { Address, AleoNetworkClient, SealanceMerkleTree } from "@provablehq/sdk/testnet.js";
  ```

  Change:
  ```ts
  import {
    configToPlaintext,
    createStreamParamsToPlaintext,
    fieldLiteral,
    identLiteral,
    parseBoolLiteral,
    parseFeeTier,
    parsePayrollConfig,
    parseStreamAnchor,
    streamAnchorToPlaintext,
    tokenPriceToPlaintext,
  } from "../../../sdk/plaintext.ts";
  ```
  to:
  ```ts
  import {
    configToPlaintext,
    createStreamParamsToPlaintext,
    fieldLiteral,
    identLiteral,
    parseBoolLiteral,
    parseFeeTier,
    parsePayroll,
    parsePayrollConfig,
    parseStreamAnchor,
    payrollToPlaintext,
    streamAnchorToPlaintext,
    tokenPriceToPlaintext,
  } from "../../../sdk/plaintext.ts";
  ```

  Change:
  ```ts
  import type {
    Config,
    CreateStreamParams,
    FeeTier,
    PayrollConfig,
    StreamAnchor,
    TokenPrice,
  } from "../../../sdk/types.ts";
  ```
  to:
  ```ts
  import type {
    Config,
    CreateStreamParams,
    FeeTier,
    Payroll,
    PayrollConfig,
    StreamAnchor,
    TokenPrice,
  } from "../../../sdk/types.ts";
  ```

- [ ] **Step 2: Add the `programAddress` cache field**

  Change:
  ```ts
  export class WalletPayrollService {
    readonly wallet: PayrollWallet;
    readonly networkClient: AleoNetworkClient;

    constructor(wallet: PayrollWallet) {
  ```
  to:
  ```ts
  export class WalletPayrollService {
    readonly wallet: PayrollWallet;
    readonly networkClient: AleoNetworkClient;
    private programAddress: string | undefined;

    constructor(wallet: PayrollWallet) {
  ```

- [ ] **Step 3: Generalize `execute()`**

  Change:
  ```ts
    private async execute(
      functionName: string,
      inputs: string[],
      fee: number,
      imports?: string[],
    ): Promise<string> {
      const result = await this.wallet.executeTransaction({
        program: PROGRAM_ID,
        function: functionName,
        inputs,
        fee,
        privateFee: false,
        ...(imports !== undefined ? { imports } : {}),
      });
      if (result === undefined || result.transactionId === "") {
        throw new Error("wallet did not return a transaction id (rejected?)");
      }
      return result.transactionId;
    }
  ```
  to:
  ```ts
    private async execute(
      program: string,
      functionName: string,
      inputs: string[],
      fee: number,
      imports?: string[],
    ): Promise<string> {
      const result = await this.wallet.executeTransaction({
        program,
        function: functionName,
        inputs,
        fee,
        privateFee: false,
        ...(imports !== undefined ? { imports } : {}),
      });
      if (result === undefined || result.transactionId === "") {
        throw new Error("wallet did not return a transaction id (rejected?)");
      }
      return result.transactionId;
    }
  ```

- [ ] **Step 4: Update every existing call site to pass `PROGRAM_ID` explicitly**

  There are 9 call sites. Update each one (search for `this.execute(` to find them all):

  | Method | Old call | New call |
  |---|---|---|
  | `createStreamPrivate` | `this.execute("create_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` | `this.execute(PROGRAM_ID, "create_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` |
  | `pauseResumeStream` | `this.execute("pause_resume_stream_private", [ticket], fee)` | `this.execute(PROGRAM_ID, "pause_resume_stream_private", [ticket], fee)` |
  | `cancelStream` | `this.execute("cancel_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` | `this.execute(PROGRAM_ID, "cancel_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` |
  | `withdraw` | `this.execute("withdraw_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` | `this.execute(PROGRAM_ID, "withdraw_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` |
  | `topupStream` | `this.execute("topup_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` | `this.execute(PROGRAM_ID, "topup_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS)` |
  | `initializeConfig` | `this.execute("initialize_config", inputs, fee)` | `this.execute(PROGRAM_ID, "initialize_config", inputs, fee)` |
  | `updateConfig` | `this.execute("update_config", inputs, fee)` | `this.execute(PROGRAM_ID, "update_config", inputs, fee)` |
  | `setFeeTier` | `this.execute("set_fee_tier", inputs, fee)` | `this.execute(PROGRAM_ID, "set_fee_tier", inputs, fee)` |
  | `setTokenWhitelisted` | `this.execute("set_token_whitelisted", inputs, fee)` | `this.execute(PROGRAM_ID, "set_token_whitelisted", inputs, fee)` |

  Do not change the `"cancel_private"` / `"withdraw_private"` function-name strings themselves — that mismatch against `main.leo`'s actual `cancel_stream_private`/`withdraw_stream_private` names predates this task and is out of scope here.

- [ ] **Step 5: Add `getProgramAddress()` and `getPublicPayroll()`**

  Insert a new section right after the `topupStream` method and before the `// Admin: configuration management` section comment:

  ```ts
    // =======================================================================
    // User: public stream lifecycle
    // =======================================================================

    /**
     * The payroll program's own on-chain address — what `std::ctx::addr()`
     * resolves to inside the program. Needed as the `spender` for
     * `approve_public` before `create_stream_public`'s deposit transfer, and
     * matches `self_address` in `cancel_stream_public`/`withdraw_stream_public`.
     */
    getProgramAddress(): string {
      this.programAddress ??= Address.fromProgramId(PROGRAM_ID).toString();
      return this.programAddress;
    }

    /** Read and parse `payrolls[streamId]` (public streams only). */
    async getPublicPayroll(streamId: string | bigint): Promise<Payroll> {
      const value = await this.networkClient.getProgramMappingValue(
        PROGRAM_ID,
        "payrolls",
        fieldLiteral(streamId),
      );
      return parsePayroll(value);
    }
  ```

- [ ] **Step 6: Verify the file compiles**

  From `app/`:
  ```
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 7: Commit**

  ```bash
  git add app/src/payroll/WalletPayrollService.ts
  git commit -m "refactor(app): generalize WalletPayrollService.execute() and add public-payroll reads"
  ```

---

### Task 3: `WalletPayrollService` — add `createStreamPublic()`

**Files:**
- Modify: `app/src/payroll/WalletPayrollService.ts`

**Interfaces:**
- Consumes: `execute(program, ...)`, `getProgramAddress()` from Task 2; `getConfigInput()`, `resolveFeeBps()` (existing private methods, unchanged); `computeStreamFee`, `nowSeconds` (existing `sdk/math.ts` imports, unchanged); `signTokenPrice` (existing import, unchanged); `randomField()` (existing top-of-file helper, unchanged); `TOKEN_PROGRAM_ID` (existing `app/src/config.ts` import, unchanged).
- Produces: `createStreamPublic(params: CreateStreamParams, adminKey: string, fee?: number): Promise<string>` — returns the `create_stream_public` transaction id after internally submitting and confirming the prerequisite `approve_public` transaction. Used by Task 6's `PublicStreamPage`.

- [ ] **Step 1: Add `createStreamPublic()`**

  Insert immediately after `getPublicPayroll()` (added in Task 2):

  ```ts
    /**
     * Execute `create_stream_public` through the wallet. Public streams pay
     * fees from the signer's public credits balance and pull the deposit via
     * `transfer_from_public`, which requires the signer to have already
     * approved this program to spend `depositAmount` of the token — this
     * method submits that `approve_public` call on the token program first
     * and awaits its confirmation before submitting `create_stream_public`.
     *
     * `adminKey` is the config admin's private key, used only to sign the
     * TokenPrice attestation (never stored).
     */
    async createStreamPublic(
      params: CreateStreamParams,
      adminKey: string,
      fee: number = DEFAULT_FEE,
    ): Promise<string> {
      const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
      const config = await this.getConfigInput();
      const tokenPrice: TokenPrice = {
        config: CONFIG_NAME,
        streamToken: TOKEN_PROGRAM,
        streamTokenPriceUsd: TOKEN_PRICE_USD,
        aleoPriceUsd: ALEO_PRICE_USD,
        priceExpiry: nowSeconds() + 3600n,
        nonce: randomField(),
      };
      const priceSignature = signTokenPrice(adminKey, tokenPrice);
      // usdValue does not depend on feeBps; resolve the tier from it, then fee.
      const { usdValue } = computeStreamFee(
        params.amount,
        TOKEN_PRICE_USD,
        ALEO_PRICE_USD,
        0n,
      );
      const feeBps = await this.resolveFeeBps(usdValue);

      const approveTxId = await this.execute(
        TOKEN_PROGRAM_ID,
        "approve_public",
        [this.getProgramAddress(), `${depositAmount}u128`],
        fee,
      );
      console.log("approve_public tx:", approveTxId);
      await this.waitForConfirmation(approveTxId);

      const inputs = [
        createStreamParamsToPlaintext(params),
        identLiteral(TOKEN_PROGRAM),
        configToPlaintext(config),
        tokenPriceToPlaintext(tokenPrice),
        priceSignature,
        `${feeBps}u64`,
      ];
      return this.execute(PROGRAM_ID, "create_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
    }
  ```

- [ ] **Step 2: Verify the file compiles**

  From `app/`:
  ```
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add app/src/payroll/WalletPayrollService.ts
  git commit -m "feat(app): add createStreamPublic to WalletPayrollService"
  ```

---

### Task 4: `WalletPayrollService` — add `pauseResumeStreamPublic()`, `cancelStreamPublic()`, `withdrawStreamPublic()`

**Files:**
- Modify: `app/src/payroll/WalletPayrollService.ts`

**Interfaces:**
- Consumes: `execute(program, ...)` from Task 2; `getPublicPayroll()` from Task 2; `getStreamAnchor()` (existing, unchanged); `payrollToPlaintext`, `streamAnchorToPlaintext` (existing imports, `payrollToPlaintext` added in Task 2's import edit).
- Produces: `pauseResumeStreamPublic(streamId, fee?): Promise<string>`, `cancelStreamPublic(streamId, fee?): Promise<string>`, `withdrawStreamPublic(streamId, fee?): Promise<string>`. Used by Task 6's `PublicStreamPage`.

- [ ] **Step 1: Add the three methods**

  Insert immediately after `createStreamPublic()` (added in Task 3):

  ```ts
    /** Execute `pause_resume_stream_public` (toggles pause/resume). Sender only. */
    async pauseResumeStreamPublic(
      streamId: string | bigint,
      fee: number = DEFAULT_FEE,
    ): Promise<string> {
      return this.execute(PROGRAM_ID, "pause_resume_stream_public", [fieldLiteral(streamId)], fee);
    }

    /** Execute `cancel_stream_public`. Sender only. */
    async cancelStreamPublic(
      streamId: string | bigint,
      fee: number = DEFAULT_FEE,
    ): Promise<string> {
      const payroll = await this.getPublicPayroll(streamId);
      const anchor = await this.getStreamAnchor(streamId);
      const inputs = [payrollToPlaintext(payroll), streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
      return this.execute(PROGRAM_ID, "cancel_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
    }

    /** Execute `withdraw_stream_public`. Receiver only. */
    async withdrawStreamPublic(
      streamId: string | bigint,
      fee: number = DEFAULT_FEE,
    ): Promise<string> {
      const payroll = await this.getPublicPayroll(streamId);
      const anchor = await this.getStreamAnchor(streamId);
      const inputs = [payrollToPlaintext(payroll), streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
      return this.execute(PROGRAM_ID, "withdraw_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
    }
  ```

- [ ] **Step 2: Verify the file compiles**

  From `app/`:
  ```
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add app/src/payroll/WalletPayrollService.ts
  git commit -m "feat(app): add pause/cancel/withdraw for public streams to WalletPayrollService"
  ```

---

### Task 5: Local known-stream-id store

**Files:**
- Create: `app/src/pages/publicStreamStore.ts`

**Interfaces:**
- Produces: `loadKnownStreamIds(address: string): string[]`, `addKnownStreamId(address: string, streamId: string): void`. Used by Task 6's `PublicStreamPage`.

- [ ] **Step 1: Create the store module**

  ```ts
  /**
   * Public streams have no ticket records for the wallet to enumerate (state
   * lives entirely in the `payrolls`/`stream_anchors` mappings, keyed by
   * `stream_id`, with no on-chain index of "streams by sender/receiver"). This
   * module remembers, per connected address, which stream ids the app has
   * created or been told about, in `localStorage`, so the UI has something to
   * list and refresh.
   */

  const STORAGE_PREFIX = "zebec.publicStreams.";

  function storageKey(address: string): string {
    return `${STORAGE_PREFIX}${address}`;
  }

  /** Known public stream ids for `address`, in the order they were added. */
  export function loadKnownStreamIds(address: string): string[] {
    try {
      const raw = localStorage.getItem(storageKey(address));
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }

  /** Remember `streamId` for `address` (no-op if already known). */
  export function addKnownStreamId(address: string, streamId: string): void {
    const ids = loadKnownStreamIds(address);
    if (ids.includes(streamId)) return;
    ids.push(streamId);
    try {
      localStorage.setItem(storageKey(address), JSON.stringify(ids));
    } catch {
      // localStorage unavailable (private browsing, quota) — best effort only.
    }
  }
  ```

- [ ] **Step 2: Verify the file compiles**

  From `app/`:
  ```
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add app/src/pages/publicStreamStore.ts
  git commit -m "feat(app): add localStorage-backed known-public-stream-id store"
  ```

---

### Task 6: `PublicStreamPage` UI

**Files:**
- Create: `app/src/pages/PublicStreamPage.tsx`

**Interfaces:**
- Consumes: `UsePayroll` (`app/src/hooks/usePayroll.ts`, unchanged); `WalletPayrollService.createStreamPublic/pauseResumeStreamPublic/cancelStreamPublic/withdrawStreamPublic/getPublicPayroll/getStreamAnchor/getWithdrawableAmounts` (Tasks 2–4); `loadKnownStreamIds`/`addKnownStreamId` (Task 5); `Payroll`/`StreamAnchor`/`CreateStreamParams` types (`sdk/types.ts`); `WithdrawableAmounts` (`sdk/math.ts`); `fieldLiteral` (`sdk/plaintext.ts`); `parseBig`/`parseFee`/`randomField`/`requirePrefix` (`app/src/pages/form.ts`, unchanged); `DEFAULT_FEE` (`app/src/config.ts`, unchanged).
- Produces: default-exported `PublicStreamPage({ payroll }: { payroll: UsePayroll })` component. Used by Task 7's `App.tsx`.

- [ ] **Step 1: Create the page component**

  ```tsx
  import { useCallback, useEffect, useState } from "react";
  import type { CreateStreamParams, Payroll, StreamAnchor } from "../../../sdk/types.ts";
  import type { WithdrawableAmounts } from "../../../sdk/math.ts";
  import { fieldLiteral } from "../../../sdk/plaintext.ts";
  import { DEFAULT_FEE } from "../config.ts";
  import type { UsePayroll } from "../hooks/usePayroll.ts";
  import { parseBig, parseFee, randomField, requirePrefix } from "./form.ts";
  import { addKnownStreamId, loadKnownStreamIds } from "./publicStreamStore.ts";

  interface KnownStream {
    streamId: string;
    role: "sender" | "receiver" | "other";
    payroll?: Payroll;
    anchor?: StreamAnchor;
    withdrawable?: WithdrawableAmounts;
    note?: string;
  }

  function anchorStatus(anchor: StreamAnchor): string {
    if (anchor.canceled) return "canceled";
    if (anchor.paused) return "paused";
    return "active";
  }

  export default function PublicStreamPage({ payroll }: { payroll: UsePayroll }) {
    const { busy, runTx, service, address } = payroll;

    // Create-stream form state.
    const [receiver, setReceiver] = useState("");
    const [amount, setAmount] = useState("2000000");
    const [duration, setDuration] = useState("600");
    const [startNow, setStartNow] = useState(true);
    const [startTime, setStartTime] = useState("");
    const [isCancelable, setIsCancelable] = useState(true);
    const [isPausable, setIsPausable] = useState(true);
    const [autoWithdrawable, setAutoWithdrawable] = useState(false);
    const [canTopup, setCanTopup] = useState(false);
    const [withdrawFrequency, setWithdrawFrequency] = useState("0");
    const [initialBufferAmount, setInitialBufferAmount] = useState("0");
    const [adminKey, setAdminKey] = useState("");
    const [fee, setFee] = useState(String(DEFAULT_FEE));
    const [formError, setFormError] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);

    // Known public streams (localStorage-tracked; no ticket records exist).
    const [streams, setStreams] = useState<KnownStream[]>([]);
    const [listNote, setListNote] = useState<string | null>(null);
    const [manualStreamId, setManualStreamId] = useState("");

    const refreshStreams = useCallback(async () => {
      if (service === null || address === null) return;
      setListNote(null);
      const ids = loadKnownStreamIds(address);
      const rows: KnownStream[] = [];
      for (const streamId of ids) {
        try {
          const payrollInfo = await service.getPublicPayroll(streamId);
          const anchor = await service.getStreamAnchor(streamId);
          const role: KnownStream["role"] =
            payrollInfo.sender === address
              ? "sender"
              : payrollInfo.receiver === address
                ? "receiver"
                : "other";
          let withdrawable: WithdrawableAmounts | undefined;
          if (role === "receiver") {
            try {
              withdrawable = await service.getWithdrawableAmounts(streamId);
            } catch {
              withdrawable = undefined;
            }
          }
          rows.push({
            streamId,
            role,
            payroll: payrollInfo,
            anchor,
            ...(withdrawable !== undefined ? { withdrawable } : {}),
          });
        } catch {
          rows.push({ streamId, role: "other", note: "no on-chain payroll/anchor found" });
        }
      }
      setStreams(rows);
    }, [service, address]);

    useEffect(() => {
      void refreshStreams();
    }, [refreshStreams]);

    const onCreate = async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setResult(null);
      let params: CreateStreamParams;
      let feeMicro: number;
      try {
        const startNowValue = startNow;
        const start = startNowValue
          ? 0n
          : parseBig(startTime, "start time (unix seconds)", { positive: true });
        if (!startNowValue && start <= BigInt(Math.floor(Date.now() / 1000))) {
          throw new Error("start time is in the past");
        }
        params = {
          receiver: requirePrefix(receiver, "aleo1", "receiver"),
          streamId: randomField(),
          amount: parseBig(amount, "amount", { positive: true }),
          startTime: start,
          duration: parseBig(duration, "duration (seconds)", { positive: true }),
          isCancelable,
          isPausable,
          autoWithdrawable,
          withdrawFrequency: autoWithdrawable
            ? parseBig(withdrawFrequency, "withdraw frequency", { positive: true })
            : 0n,
          startNow: startNowValue,
          canTopup,
          initialBufferAmount: canTopup
            ? parseBig(initialBufferAmount, "initial buffer amount", { positive: true })
            : 0n,
        };
        feeMicro = parseFee(fee);
        requirePrefix(adminKey, "APrivateKey1", "admin attestation key");
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
        return;
      }
      const anchor = await runTx(async (svc) => {
        const txId = await svc.createStreamPublic(params, adminKey.trim(), feeMicro);
        setResult(`create_stream_public submitted: ${txId}\nwaiting for confirmation...`);
        await svc.waitForConfirmation(txId);
        return svc.getStreamAnchor(params.streamId);
      });
      if (anchor !== undefined && address !== null) {
        setResult(
          `stream created: ${anchor.streamId}\nstatus: ${anchorStatus(anchor)}` +
            ` · deposited ${anchor.depositedAmount} · duration ${anchor.duration}s`,
        );
        setAdminKey("");
        addKnownStreamId(address, anchor.streamId);
        await refreshStreams();
      }
    };

    const onAddManualStream = (e: React.FormEvent) => {
      e.preventDefault();
      setListNote(null);
      if (address === null) return;
      let id: string;
      try {
        id = fieldLiteral(manualStreamId);
      } catch (err) {
        setListNote(err instanceof Error ? err.message : String(err));
        return;
      }
      addKnownStreamId(address, id);
      setManualStreamId("");
      void refreshStreams();
    };

    const onPauseResume = async (streamId: string) => {
      await runTx(async (svc) => {
        const txId = await svc.pauseResumeStreamPublic(streamId);
        await svc.waitForConfirmation(txId);
      });
      await refreshStreams();
    };

    const onCancel = async (streamId: string) => {
      await runTx(async (svc) => {
        const txId = await svc.cancelStreamPublic(streamId);
        await svc.waitForConfirmation(txId);
      });
      await refreshStreams();
    };

    const onWithdraw = async (streamId: string) => {
      await runTx(async (svc) => {
        const txId = await svc.withdrawStreamPublic(streamId);
        await svc.waitForConfirmation(txId);
      });
      await refreshStreams();
    };

    return (
      <>
        <section className="card">
          <h2>Create public stream</h2>
          <form className="grid" onSubmit={onCreate}>
            <label className="field full">
              Receiver address
              <input
                value={receiver}
                onChange={(e) => setReceiver(e.target.value)}
                placeholder="aleo1..."
                disabled={busy}
              />
            </label>
            <label className="field">
              Amount (token units)
              <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            </label>
            <label className="field">
              Duration (seconds)
              <input value={duration} onChange={(e) => setDuration(e.target.value)} disabled={busy} />
            </label>
            <label className="field check">
              <input
                type="checkbox"
                checked={startNow}
                onChange={(e) => setStartNow(e.target.checked)}
                disabled={busy}
              />
              Start now
            </label>
            <label className="field">
              Start time (unix seconds)
              <input
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={busy || startNow}
              />
            </label>
            <label className="field check">
              <input
                type="checkbox"
                checked={isCancelable}
                onChange={(e) => setIsCancelable(e.target.checked)}
                disabled={busy}
              />
              Cancelable
            </label>
            <label className="field check">
              <input
                type="checkbox"
                checked={isPausable}
                onChange={(e) => setIsPausable(e.target.checked)}
                disabled={busy}
              />
              Pausable
            </label>
            <label className="field check">
              <input
                type="checkbox"
                checked={autoWithdrawable}
                onChange={(e) => setAutoWithdrawable(e.target.checked)}
                disabled={busy}
              />
              Auto-withdrawable
            </label>
            <label className="field">
              Withdraw frequency (seconds)
              <input
                value={withdrawFrequency}
                onChange={(e) => setWithdrawFrequency(e.target.value)}
                disabled={busy || !autoWithdrawable}
              />
            </label>
            <label className="field check">
              <input
                type="checkbox"
                checked={canTopup}
                onChange={(e) => setCanTopup(e.target.checked)}
                disabled={busy}
              />
              Top-up funding (buffer)
            </label>
            <label className="field">
              Initial buffer amount (token units)
              <input
                value={initialBufferAmount}
                onChange={(e) => setInitialBufferAmount(e.target.value)}
                disabled={busy || !canTopup}
              />
            </label>
            <label className="field full">
              Admin attestation key (signs the TokenPrice; never stored)
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="APrivateKey1..."
                disabled={busy}
                autoComplete="off"
              />
            </label>
            <label className="field">
              Fee (microcredits)
              <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
            </label>
            <p className="muted full">
              Submitting requests two wallet transactions: <code>approve_public</code> on the token
              program (letting this program pull the deposit), then <code>create_stream_public</code>.
            </p>
            {formError !== null && <p className="form-error">{formError}</p>}
            <div className="full">
              <button className="action" type="submit" disabled={busy}>
                {busy ? "Working..." : "Create public stream"}
              </button>
            </div>
          </form>
          {result !== null && <p className="result">{result}</p>}
        </section>

        <section className="card">
          <h2>My public streams</h2>
          <form className="row-actions" style={{ marginBottom: "0.75rem" }} onSubmit={onAddManualStream}>
            <input
              value={manualStreamId}
              onChange={(e) => setManualStreamId(e.target.value)}
              placeholder="stream id (e.g. 42field)"
              disabled={busy}
            />
            <button
              className="action secondary"
              type="submit"
              disabled={busy || manualStreamId.trim() === ""}
            >
              Add stream
            </button>
            <button
              className="action secondary"
              type="button"
              onClick={() => void refreshStreams()}
              disabled={busy}
            >
              Refresh
            </button>
          </form>
          {listNote !== null && <p className="form-error">{listNote}</p>}
          {streams.length === 0 ? (
            <p className="muted">
              No known public streams yet. Create one above, or add a stream id you were given.
            </p>
          ) : (
            <table className="streams">
              <thead>
                <tr>
                  <th>Stream id</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Withdrawable now</th>
                  <th>Withdrawn / Deposited</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {streams.map((s) => (
                  <tr key={s.streamId}>
                    <td>{s.streamId}</td>
                    <td>{s.role}</td>
                    <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                    <td>
                      {s.role === "receiver" && s.withdrawable !== undefined
                        ? s.withdrawable.currentlyWithdrawable.toString()
                        : "—"}
                    </td>
                    <td>
                      {s.anchor !== undefined
                        ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                        : "—"}
                    </td>
                    <td>
                      <div className="row-actions">
                        {s.role === "sender" && s.payroll !== undefined && s.anchor !== undefined && (
                          <>
                            <button
                              className="action secondary"
                              onClick={() => void onPauseResume(s.streamId)}
                              disabled={busy || !s.payroll.isPausable || s.anchor.canceled}
                            >
                              {s.anchor.paused ? "Resume" : "Pause"}
                            </button>
                            <button
                              className="action danger"
                              onClick={() => void onCancel(s.streamId)}
                              disabled={busy || !s.payroll.isCancelable || s.anchor.canceled}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {s.role === "receiver" && (
                          <button
                            className="action"
                            onClick={() => void onWithdraw(s.streamId)}
                            disabled={
                              busy ||
                              s.anchor === undefined ||
                              s.anchor.canceled ||
                              s.withdrawable === undefined ||
                              s.withdrawable.currentlyWithdrawable <= 0n
                            }
                          >
                            Withdraw
                          </button>
                        )}
                        {s.role === "other" && <span className="muted">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </>
    );
  }
  ```

- [ ] **Step 2: Verify the file compiles**

  From `app/`:
  ```
  npx tsc --noEmit
  ```
  Expected: no errors. (This file isn't imported anywhere yet, but `tsc` type-checks the whole `app/src` tree per `app/tsconfig.json`'s `include`, so it's checked regardless.)

- [ ] **Step 3: Commit**

  ```bash
  git add app/src/pages/PublicStreamPage.tsx
  git commit -m "feat(app): add PublicStreamPage UI for public stream operations"
  ```

---

### Task 7: Wire `PublicStreamPage` into `App.tsx` and final verification

**Files:**
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `PublicStreamPage` default export from Task 6.

- [ ] **Step 1: Add the import**

  Change:
  ```tsx
  import { usePayroll } from "./hooks/usePayroll.ts";
  import EmployerPage from "./pages/EmployerPage.tsx";
  import EmployeePage from "./pages/EmployeePage.tsx";
  import AdminPage from "./pages/AdminPage.tsx";
  import DeployPage from "./pages/DeployPage.tsx";
  ```
  to:
  ```tsx
  import { usePayroll } from "./hooks/usePayroll.ts";
  import EmployerPage from "./pages/EmployerPage.tsx";
  import EmployeePage from "./pages/EmployeePage.tsx";
  import PublicStreamPage from "./pages/PublicStreamPage.tsx";
  import AdminPage from "./pages/AdminPage.tsx";
  import DeployPage from "./pages/DeployPage.tsx";
  ```

- [ ] **Step 2: Add the tab**

  Change:
  ```tsx
  type Tab = "employer" | "employee" | "admin" | "deploy";

  const TABS: { id: Tab; label: string }[] = [
    { id: "employer", label: "Employer" },
    { id: "employee", label: "Employee" },
    { id: "admin", label: "Admin" },
    { id: "deploy", label: "Deploy" },
  ];
  ```
  to:
  ```tsx
  type Tab = "employer" | "employee" | "public" | "admin" | "deploy";

  const TABS: { id: Tab; label: string }[] = [
    { id: "employer", label: "Employer" },
    { id: "employee", label: "Employee" },
    { id: "public", label: "Public Streams" },
    { id: "admin", label: "Admin" },
    { id: "deploy", label: "Deploy" },
  ];
  ```

- [ ] **Step 3: Render the page**

  Change:
  ```tsx
          {tab === "employer" && <EmployerPage payroll={payroll} />}
          {tab === "employee" && <EmployeePage payroll={payroll} />}
          {tab === "admin" && <AdminPage payroll={payroll} />}
          {tab === "deploy" && <DeployPage payroll={payroll} />}
  ```
  to:
  ```tsx
          {tab === "employer" && <EmployerPage payroll={payroll} />}
          {tab === "employee" && <EmployeePage payroll={payroll} />}
          {tab === "public" && <PublicStreamPage payroll={payroll} />}
          {tab === "admin" && <AdminPage payroll={payroll} />}
          {tab === "deploy" && <DeployPage payroll={payroll} />}
  ```

- [ ] **Step 4: Full verification**

  From `app/`:
  ```
  npx tsc --noEmit
  npx vite build
  ```
  Expected: both succeed with no errors (the `vite build` chunk-size warning that already exists on `main` is fine and unrelated).

  Then start the dev server and visually confirm the new tab renders (wallet connection is required to see past the "Connect your Shield wallet to continue" gate, so this only confirms the tab exists and the app loads without console errors — exercising the actual create/pause/cancel/withdraw flow against a live wallet and testnet deployment is **not possible in this environment** and should be done by the user):
  ```
  npx vite
  ```
  Open the printed local URL, confirm a "Public Streams" tab button appears next to "Employer"/"Employee", and check the browser console for errors.

- [ ] **Step 5: Commit**

  ```bash
  git add app/src/App.tsx
  git commit -m "feat(app): add Public Streams tab to the app shell"
  ```
