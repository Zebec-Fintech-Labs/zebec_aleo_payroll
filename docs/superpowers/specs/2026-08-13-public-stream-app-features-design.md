# Public stream features in the web app

Date: 2026-08-13

## Context

`src/main.leo` already implements public-stream operations on
`test_zebec_payroll_v3.aleo`: `create_stream_public`,
`pause_resume_stream_public`, `cancel_stream_public`,
`withdraw_stream_public`, plus `view fn get_payroll` /
`view fn get_stream_anchor`. The web app (`app/`) and the shared SDK layer
(`sdk/`) only support the private-stream operations
(`create_stream_private`, `pause_resume_stream_private`,
`cancel_stream_private`, `withdraw_stream_private`, `topup_stream_private`)
via `WalletPayrollService` and the `EmployerPage`/`EmployeePage` UI. This
spec adds the missing public-stream support end to end: SDK types/codecs,
service methods, and a new UI tab. Top-up is out of scope — there is no
`topup_stream_public` transition in `main.leo`.

Public streams differ from private streams in two structural ways that
drive this design:

1. **No ticket records.** Private-stream state (who is the sender/receiver,
   full amount, flags) lives in `SenderPayrollTicket` /
   `ReceiverPayrollTicket` records owned by the wallet, which is how
   `WalletPayrollService.listMyTickets()` discovers "my streams". Public
   streams store the equivalent data in the `payrolls` mapping (a `Payroll`
   struct keyed by `stream_id`), which is not enumerable by owner — there is
   no on-chain index of "all streams where `sender == X`". The app has no
   way to discover a wallet's public streams other than remembering stream
   IDs itself.
2. **Deposit requires a prior approval.** `create_stream_private` spends a
   private token record directly. `create_stream_public` instead calls
   `IARC22@(token_program)::transfer_from_public(signer, self_address, deposit_amount)`,
   which requires the signer to have already called `approve_public` on the
   token program with `spender = self_address` (the payroll program's own
   address). Cancel/withdraw do not need this — they move funds the payroll
   program already owns.

## SDK layer (`sdk/`)

### `sdk/types.ts`

Add a `Payroll` interface mirroring the Leo `Payroll` struct **in its exact
declaration order** (required for BHP256 hashing / plaintext parity with
the existing structs):

```ts
export interface Payroll {
  streamId: string;
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

### `sdk/plaintext.ts`

- `payrollToPlaintext(p: Payroll): string` — serializer following the same
  pattern as `streamAnchorToPlaintext`, member order matching the struct
  declaration above, validated with `Plaintext.fromString`.
- `parsePayroll(plaintext: string): Payroll` — parser following the same
  pattern as `parseStreamAnchor`.

No changes needed to `sdk/hashing.ts` or `sdk/math.ts` — fee and
withdrawable-amount math is already generic over public/private streams.

## `app/src/payroll/WalletPayrollService.ts`

### Refactor: generalize `execute()`

The private `execute(functionName, inputs, fee, imports?)` always targets
`PROGRAM_ID`. Add a `program` parameter (defaulting to `PROGRAM_ID`) so the
new create-stream-public flow can also submit a transaction to the token
program:

```ts
private async execute(
  program: string,
  functionName: string,
  inputs: string[],
  fee: number,
  imports?: string[],
): Promise<string>
```

Update all existing call sites (`createStreamPrivate`, `pauseResumeStream`,
`cancelStream`, `withdraw`, `topupStream`, the admin methods) to pass
`PROGRAM_ID` explicitly.

### New method: `getProgramAddress()`

```ts
private programAddress: string | undefined;

getProgramAddress(): string {
  this.programAddress ??= Address.fromProgramId(PROGRAM_ID).to_string();
  return this.programAddress;
}
```

This is the payroll program's own on-chain address (what `std::ctx::addr()`
resolves to inside the program) — needed as the `spender` for
`approve_public` and matches `self_address` in `main.leo`. `Address` is
imported from `@provablehq/sdk/testnet.js` alongside the existing
`AleoNetworkClient`/`SealanceMerkleTree` imports.

### New method: `getPublicPayroll(streamId)`

```ts
async getPublicPayroll(streamId: string | bigint): Promise<Payroll> {
  const value = await this.networkClient.getProgramMappingValue(
    PROGRAM_ID,
    "payrolls",
    fieldLiteral(streamId),
  );
  return parsePayroll(value);
}
```

Parallel to the existing `getStreamAnchor`.

### New method: `createStreamPublic(params, adminKey, fee)`

Same shape as `createStreamPrivate` up through fee/tier resolution
(config read, signed `TokenPrice`, `resolveFeeBps`, `computeStreamFee`,
auto-withdrawal fee), but:

- No credit record / token record / merkle-proof lookups (public streams
  pay fees from the signer's public balance and pull the deposit via
  `transfer_from_public`, not private records).
- Before submitting `create_stream_public`, submit and **await
  confirmation** of `approve_public(programAddress, depositAmount)` on the
  token program:

```ts
async createStreamPublic(
  params: CreateStreamParams,
  adminKey: string,
  fee: number = DEFAULT_FEE,
): Promise<string> {
  const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
  const config = await this.getConfigInput();
  const tokenPrice: TokenPrice = { /* same construction as createStreamPrivate */ };
  const priceSignature = signTokenPrice(adminKey, tokenPrice);
  const { usdValue } = computeStreamFee(params.amount, TOKEN_PRICE_USD, ALEO_PRICE_USD, 0n);
  const feeBps = await this.resolveFeeBps(usdValue);

  const approveTxId = await this.execute(
    TOKEN_PROGRAM_ID,
    "approve_public",
    [this.getProgramAddress(), `${depositAmount}u128`],
    fee,
  );
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

Returns the `create_stream_public` transaction id; the caller (UI) awaits
its confirmation itself, matching the existing convention (the approval's
confirmation is awaited internally since it's a prerequisite, not the
result).

### New method: `pauseResumeStreamPublic(streamId, fee)`

```ts
async pauseResumeStreamPublic(streamId: string | bigint, fee: number = DEFAULT_FEE): Promise<string> {
  return this.execute(PROGRAM_ID, "pause_resume_stream_public", [fieldLiteral(streamId)], fee);
}
```

No dynamic imports — this transition never calls the token program.

### New methods: `cancelStreamPublic` / `withdrawStreamPublic`

Both fetch the current `Payroll` and `StreamAnchor` and submit with `now`:

```ts
async cancelStreamPublic(streamId: string | bigint, fee: number = DEFAULT_FEE): Promise<string> {
  const payroll = await this.getPublicPayroll(streamId);
  const anchor = await this.getStreamAnchor(streamId);
  const inputs = [payrollToPlaintext(payroll), streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
  return this.execute(PROGRAM_ID, "cancel_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
}

async withdrawStreamPublic(streamId: string | bigint, fee: number = DEFAULT_FEE): Promise<string> {
  const payroll = await this.getPublicPayroll(streamId);
  const anchor = await this.getStreamAnchor(streamId);
  const inputs = [payrollToPlaintext(payroll), streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
  return this.execute(PROGRAM_ID, "withdraw_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
}
```

`getWithdrawableAmounts` is already generic over `StreamAnchor` and needs
no change — it works for public streams as-is.

## Local stream tracking: `app/src/pages/publicStreamStore.ts`

Since public streams aren't discoverable from wallet records, the app
remembers stream IDs the connected address has created or been told about,
per-address, in `localStorage`:

```ts
const STORAGE_PREFIX = "zebec.publicStreams.";

export function loadKnownStreamIds(address: string): string[] { /* ... */ }
export function addKnownStreamId(address: string, streamId: string): void { /* dedupe, persist */ }
```

Failure to read/parse localStorage degrades to an empty list rather than
throwing (private/incognito browsing, corrupted value, etc.).

## New UI: `app/src/pages/PublicStreamPage.tsx`

A new tab, added to `App.tsx`'s `TABS`/`Tab` type and rendered next to
`EmployerPage`/`EmployeePage`/`AdminPage`/`DeployPage`, following the same
`{ payroll: UsePayroll }` prop convention.

### Create section

Same form fields as `EmployerPage`'s create form (receiver, amount,
duration, start now/start time, cancelable, pausable, auto-withdrawable +
frequency, top-up + initial buffer, admin attestation key, fee) reusing
`app/src/pages/form.ts` helpers (`parseBig`, `parseFee`, `requirePrefix`,
`randomField`). The submit handler calls `svc.createStreamPublic(...)`
(which internally chains the approve + create-stream transactions),
awaits confirmation of the returned tx id, then calls
`addKnownStreamId(address, streamId)` and refreshes the known-streams
table. The result message notes that two wallet-signed transactions
(approve, then create) will be requested.

### Known streams section

On mount / refresh: load known IDs via `loadKnownStreamIds(address)`, then
for each ID fetch `getPublicPayroll` + `getStreamAnchor` (+
`getWithdrawableAmounts` when the row is a receiver row) in parallel.
Includes a manual "add stream by ID" input + button (calls
`addKnownStreamId` then refreshes) for a receiver who was told a stream ID
out-of-band.

Each row detects its **role** relative to the connected address
(`sender` / `receiver` / other — "other" can happen if a stream ID was
added manually but doesn't belong to this address; still shown read-only)
and renders only the actions that role can perform:

- **Sender:** Pause/Resume (enabled only if `payroll.isPausable` and the
  anchor isn't canceled), Cancel (enabled only if `payroll.isCancelable`
  and the anchor isn't canceled).
- **Receiver:** Withdraw (enabled only if withdrawable amount > 0 and the
  anchor isn't canceled).

Table columns: Stream ID, Role, Status (active/paused/canceled, same
`anchorStatus` helper as the existing pages), Withdrawable now (receiver
rows only), Withdrawn / Deposited, Actions. Errors and busy states reuse
the existing `runTx`/`busy`/`error` plumbing from `UsePayroll`.

## Testing

The app has no automated test harness (`app/package.json` only has
`dev`/`build`/`preview` scripts; `build` runs `tsc && vite build`).
Verification for this change is:

1. `tsc` (via `npm run build` in `app/`) passes with no type errors.
2. `vite build` succeeds.
3. Manual exercise of the new tab against a live Shield wallet + testnet
   deployment is **not possible in this environment** and is called out
   explicitly as follow-up verification the user should do themselves.
