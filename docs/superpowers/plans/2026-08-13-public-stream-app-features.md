# Public Stream App Features Implementation Plan

**Goal:** Add create/pause-resume/cancel/withdraw support for **public** payroll
streams to the web app (`app/`), plus a token-allowance card, accounting for the
two structural differences public streams have (no ticket records; deposit
requires a prior `approve_public`).

**Status:** Implemented. SDK codec, service methods, `WalletArc22Service`, and
the `PublicStreamPage` UI (with the "Public Streams" tab) are all landed. This
document is kept up to date with the implemented design.

## Architecture

- **Shared SDK codec layer** (`sdk/types.ts`, `sdk/plaintext.ts`): a `Payroll`
  struct mirror (`stream_id, config, sender, receiver, full_amount,
  token_program, is_cancelable, is_pausable, auto_withdrawable, can_topup,
  topup_count, initialized` — exact Leo declaration order) with
  `payrollToPlaintext` / `parsePayroll` / `parseIdentLiteral`, covered by unit
  tests in `sdk-tests/unit/plaintext.test.ts`.
- **`WalletPayrollService`** (`app/src/payroll/WalletPayrollService.ts`):
  `createStreamPublic` (submits `create_stream_public`; assumes the token
  allowance is in place), `pauseResumeStreamPublic`, `cancelStreamPublic`,
  `withdrawPublic`, the `payrolls` mapping read `getPayroll`, and
  `getProgramAddress()` (the payroll program's own address, derived via
  `Address.fromProgramId`, needed as the `spender` for `approve_public`).
- **`WalletArc22Service`** (`app/src/payroll/WalletArc22Service.ts`):
  wallet-backed `approve_public` / `unapprove_public` on the token program plus
  offline view reads (`getAllowance`, `getBalanceOf`) and `waitForConfirmation`.
- **Local stream tracking** (`app/src/pages/publicStreamStore.ts`): a
  localStorage-backed "known stream ids" store keyed by address, since public
  streams have no wallet records to enumerate.
- **UI** (`app/src/pages/PublicStreamPage.tsx`): a "Public Streams" tab wired
  into `App.tsx`.

## Approve flow (final)

Chosen approach: **auto-approve + allowance card**.

- The create handler reads the current token allowance via
  `WalletArc22Service.getAllowance(address, programAddress)`. If it is below the
  deposit, it submits `approve_public(programAddress, depositAmount)` and awaits
  confirmation, then submits `create_stream_public`. Two wallet popups may be
  requested on first create.
- A dedicated **Token allowance** card shows the current allowance and the
  connected balance, with amount inputs for Approve / Unapprove so the employer
  can pre-fund the allowance or revoke it.
- `WalletPayrollService.createStreamPublic` itself does NOT chain the approval —
  that orchestration lives in the page via `WalletArc22Service`.

## `usePayroll` hook

Extends `UsePayroll` with `runAsync<T>(op: () => Promise<T>)` — the same
busy/error wrapper as `runTx`, but for arbitrary operations (e.g. the token
`WalletArc22Service` methods, which are not `WalletPayrollService` methods) so
they still flip the global `busy` state.

## `PublicStreamPage`

Three sections, reusing the existing `card`/`grid`/`field`/`streams`/`row-actions`
styles and the `UsePayroll` plumbing:

1. **Create public stream** — same fields as `EmployerPage`'s create form
   (receiver, amount, duration, start now/start time, cancelable, pausable,
   auto-withdrawable + frequency, top-up + initial buffer, admin attestation
   key, fee), reusing `form.ts` helpers. Submits the approve (when needed) and
   create transactions, then records the stream id in the local store.
2. **Token allowance** — token, payroll program address, current allowance, and
   balance, plus Approve / Unapprove amount inputs.
3. **My public streams** — manual "add stream id" input, Refresh, and a table
   (Stream id, Role, Status, Withdrawable now, Withdrawn / Deposited, Actions).
   Role is derived from `payroll.sender` / `payroll.receiver` vs the connected
   address. Sender rows get Pause/Resume (if `isPausable`) and Cancel (if
   `isCancelable`); receiver rows get Withdraw (when withdrawable > 0); "other"
   rows are read-only.

## Verification

- `npx tsc --noEmit` from `app/` — passes.
- `npx vite build` from `app/` — passes (pre-existing chunk-size warning only).
  On this Windows environment run these via `npx` directly, not `npm run build`
  (`cmd.exe` mangles the single-quoted glob in the SDK unit-test script).
- SDK unit tests (unchanged, from the repo root):
  ```
  npx tsc -p tsconfig.test.json && npx mocha .test-dist/sdk-tests/unit/**/*.test.js
  ```
- Manual exercise of the "Public Streams" tab against a live Shield wallet +
  testnet deployment is not possible in this environment and remains user
  follow-up.

## Scope notes

- No top-up support for public streams — there is no `topup_stream_public`
  transition in `src/main.leo`, so none was added.
- Spec: `docs/superpowers/specs/2026-08-13-public-stream-app-features-design.md`.
