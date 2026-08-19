# zebec-payroll-app

Browser app for the `test_zebec_payroll_v4.aleo` payroll program (testnet). It is the
wallet-based counterpart of the Node CLI flows in `../scripts/`: instead of a
`PRIVATE_KEY` env var and `ProgramManager`, all transactions are executed by
the [Shield wallet](https://shield.so/) browser extension via the
`@provablehq/aleo-wallet-adaptor-*` packages.

## Commands

```sh
yarn install
yarn dev       # vite dev server
yarn build     # tsc (typecheck) && vite build
yarn preview   # serve the production build
```

## Architecture

- `src/config.ts` — program id, explorer hosts, config name field, token
  program, fixed price attestation values, default fee (same constants as
  `scripts/payroll.ts`).
- `src/payroll/WalletPayrollService.ts` — wallet-backed counterpart of
  `sdk/client.ts`'s `PayrollService`. It is constructed from the `useWallet()`
  context (`address`, `requestRecords`, `decrypt`, `executeTransaction`,
  `executeDeployment`, `transactionStatus`) plus an `AleoNetworkClient` for
  mapping reads. It imports the SDK's pure modules (`plaintext.ts`,
  `hashing.ts`, `math.ts`, `signing.ts`, `types.ts`) directly by relative path
  (`../../../sdk/*.ts`) — no dist build, no duplication. `sdk/client.ts` and
  `sdk/records.ts` are deliberately not imported (Node/ProgramManager/chain
  scanning); the ticket-matching logic of `sdk/records.ts` is ported instead.
- `src/hooks/usePayroll.ts` — builds the service when a wallet is connected;
  exposes `runTx` for busy/error handling.
- `src/pages/` — Employer (create stream, outgoing streams with
  pause/resume/cancel), Employee (incoming streams, withdraw), Admin (config,
  fee tiers, token whitelist), Deploy (deploy/upgrade the program source via
  `executeDeployment`).

### Records via the wallet

Records are not scanned on-chain. The app calls
`requestRecords(program, false)`, keeps objects with `spent === false`, and
decrypts each `recordCiphertext` with `wallet.decrypt()`, collapsing the
plaintext to a single line. Selection rules:

- `credits.aleo` record: highest `microcredits:` >= needed.
- token record (`test_usdcx_stablecoin.aleo`): highest `amount:` >= needed.
- payroll tickets: structural match (Sender has `is_cancelable:`; Withdrawer
  has both `sender:` and `receiver:`; Receiver has `sender:` only) plus
  `stream_id:\s*<digits>field`.

### Keys

No account private key ever enters the app. The single exception is the
**admin attestation key** field on the Employer page: `create_stream_private`
verifies the `StreamTokenFee` against the config admin's Schnorr signature
on-chain, and wallets cannot reproduce `signValue` semantics, so the app signs
with `signStreamTokenFee(adminKey, tokenFee)` from `sdk/signing.ts`. The key is
kept in component state only and cleared after a successful create — it is
never persisted.

### Compliance proofs

`create_stream_private` requires a Sealance Merkle exclusion proof against the
token program's freeze list. The app fetches `FREEZE_LIST_URL`, builds the
tree with `SealanceMerkleTree` from `@provablehq/sdk/testnet.js`, and passes
`sealance.formatMerkleProof([leftProof, rightProof])` as the single
`[iarc22::MerkleProof; 2]` input.

### Notes

- `vite.config.ts` sets `build.target: "esnext"` (the SDK's wasm init uses
  top-level await), COOP/COEP headers for the dev server, and
  `server.fs.allow: [".."]` for the `../sdk` imports and the
  `build/test_zebec_payroll_v4/test_zebec_payroll_v4.aleo?raw` deploy artifact.
- `optimizeDeps.include: ["core-js/proposals/json-parse-with-source.js"]` is
  required because the excluded SDK browser bundle imports that CommonJS
  module; without pre-bundling the browser throws `require is not defined`.
- Manual testing requires the Shield wallet extension on testnet with an
  account holding credits records and `test_usdcx_stablecoin` token records.
