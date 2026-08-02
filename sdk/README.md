# aacs-payroll-sdk

TypeScript SDK for the [`aacs_payroll.aleo`](../src/main.leo) program — a
private payroll / token-streaming program on Aleo. Built on
[`@provablehq/sdk`](https://github.com/ProvableHQ/sdk) (v0.11.x), targeting
**testnet** by default.

## Features

- **Stream lifecycle** — `createStreamPrivate`, `pauseResumeStream`,
  `cancelStream`, `withdraw`.
- **Admin helpers** — `initializeConfig`, `updateConfig`, `setFeeTier`,
  `setTokenWhitelisted`, and `signTokenPrice` for the backend-signed token
  price that `create_stream_private` verifies on-chain.
- **Reads** — `getStreamAnchor`, `getPayrollConfig`, `getFeeTier`,
  `isTokenWhitelisted`, `getWithdrawableAmounts`.
- **Off-chain math/hashing** — exact mirrors of the on-chain
  `compute_stream_fee` / `compute_withdrawable_amount` and
  `BHP256::hash_to_field` (mapping keys, signed price message), verified
  against `leo run` vectors in the unit tests.
- **Record discovery** — finds unspent credits / token / payroll-ticket
  records for the configured account.

## Install & build

```bash
cd sdk
yarn install
yarn build      # tsc -> dist/
yarn test       # offline unit tests (no network)
```

## Quickstart

```ts
import { PayrollClient, configNameToField } from "aacs-payroll-sdk";

const client = new PayrollClient({
  privateKey: process.env.ALEO_PRIVATE_KEY, // APrivateKey1...
  // host: "https://api.explorer.provable.com/v1/testnet" (default)
});

// --- Admin: one-time config setup -------------------------------------
const configName = configNameToField("my-payroll"); // helper, see hashing
await client.initializeConfig(configName, feeVault, withdrawer, 1_000n, 2_000n);
await client.setFeeTier(configName, 0, { minAmount: 0n, maxAmount: 1_000_000_000n, feeBps: 25n });
await client.setTokenWhitelisted(configName, "my_token_program", true);

// --- Backend: sign a token price for a user's create-stream call ------
import { signTokenPrice } from "aacs-payroll-sdk";
const signature = signTokenPrice(adminPrivateKey, tokenPrice);

// --- Sender: create a stream ------------------------------------------
const txId = await client.createStreamPrivate(
  params,         // CreateStreamParams
  config,         // Config (must match the on-chain config)
  tokenPrice,     // TokenPrice (same object that was signed)
  signature,      // price_signature from the backend
  25n,            // fee_bps (must match the tier for the stream's USD value)
  [proofA, proofB], // [iarc22::MerkleProof; 2] for the token transfer
);

// --- Receiver: withdraw ------------------------------------------------
await client.withdraw(streamId);
```

### Value conventions

- `field` values: strings (`"123"` or `"123field"`) or `bigint`.
- `identifier` values (token program names): plain strings, e.g.
  `"my_token_program"` — serialized with Leo's single-quote literal syntax.
- Integers (`u64`, `u128`, `i64`, ...): `bigint`. USD prices use 6 decimals.
- Struct members are always serialized in the on-chain declaration order —
  this is what makes the off-chain `BHP256::hash_to_field` reproduction exact.

### Executing before deployment

When `aacs_payroll.aleo` is not deployed yet, pass the compiled program
source so executions are built locally:

```ts
import { readFileSync } from "node:fs";

const client = new PayrollClient({
  privateKey,
  programSource: readFileSync("../build/aacs_payroll/aacs_payroll.aleo", "utf8"),
});
```

(The network still rejects transactions for undeployed programs — use
`programManager.deploy(programSource, 0, false)` first; see the integration
test.)

## Integration tests

`test/integration/admin.test.ts` runs the full admin lifecycle on testnet.
It is skipped unless a funded key is provided:

```bash
cd sdk
AACS_TEST_PRIVATE_KEY=APrivateKey1... yarn test:integration
# also deploy the program first when it is not on the network:
AACS_TEST_PRIVATE_KEY=APrivateKey1... AACS_DEPLOY=1 yarn test:integration
```

Optional: `AACS_TEST_HOST` to override the API host.

Stream-lifecycle transactions are not covered by the integration test: they
additionally require a deployed IARC22 token program, funded token records,
and valid Sealance merkle proofs.

## Layout

```
src/
  types.ts      TS mirrors of the Leo structs + option types
  plaintext.ts  Leo plaintext serializers/parsers (literal strings)
  hashing.ts    BHP256 hash_to_field helpers (mapping keys, price message)
  math.ts       BigInt mirrors of the on-chain fee/vesting math
  signing.ts    admin TokenPrice signing (Schnorr)
  records.ts    unspent record discovery (credits / tokens / tickets)
  client.ts     PayrollClient (all transitions + reads)
  index.ts      public exports
test/
  unit/         offline mocha tests (yarn test)
  integration/  testnet mocha tests (yarn test:integration, env-gated)
```
