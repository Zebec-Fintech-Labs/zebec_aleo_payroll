---
name: aleo-dev
description: Use when user asks to "write a Leo program", "build an Aleo smart contract", "create an Aleo dapp", "integrate an Aleo wallet", "use @provablehq/sdk", "debug Aleo/Leo errors", "deploy to Aleo testnet", or "explain Aleo concepts" (records, mappings, transitions, finalize, view keys, zkSNARKs, credits.aleo, ARC-20/ARC-22/IARC22 tokens). End-to-end Aleo development playbook covering Leo v4 program structure, records-vs-mappings state design, transitions and final blocks, access control, security checklist, snarkVM limits, testing, TypeScript client integration (ProgramManager, record scanning, hashing parity), and browser wallet integration via @provablehq/aleo-wallet-adaptor-*.
user-invocable: true
license: MIT
compatibility: Requires Leo CLI (v4.x), Node.js 18+ for client work
metadata:
  author: Ashish Sapkota
  version: 1.0.0
---

# Aleo / Leo Development Skill

## What this Skill is for
Use this Skill when the user asks for:
- Leo program (smart contract) design, writing, or review
- Records vs mappings state-model decisions
- Client SDK work with `@provablehq/sdk` (Node or browser)
- Browser dApps with Aleo wallet adapters (Shield/Puzzle/Fox)
- Token integrations (ARC-20/ARC-22/IARC22, Sealance freeze-list compliance)
- Deployment, upgrades, testing, and debugging of Aleo programs

## Agent safety guardrails
- **Default to testnet.** Never target mainnet unless the user explicitly asks.
- **Never commit private keys** (`APrivateKey1...`) to the repo; use `.env` (gitignored) or wallet signing. `.env` files are secret — do not print them.
- **Confirm before outward actions**: deployments, upgrades, and any real transaction submission cost fees and are irreversible.
- **Constructor logic is immutable after first deployment** — treat constructor/`@upgrade` mode changes as high-stakes and call them out for explicit review.

## Core concepts (must hold true in everything you write)

### State model: records vs mappings
- **Records** = private UTXO state. Have `owner: address` + app fields + `_nonce: group` + `_version: u8`. Consumed as inputs, created as outputs. Encrypted on-chain; only the owner's view key decrypts (`record_view_key = (nonce * view_key).x`). Every spend must return **change records** — failing to return change destroys value.
- **Mappings** = public key-value state, mutated **only inside `final` blocks** via `Mapping::get`/`get_or_use`/`set`. Visible to everyone.
- Choose per datum: salaries/balances/entitlements → records; counters/registries/config/whitelists → mappings. Never put private data (amounts, recipients, schedules) in mappings unless deliberately public.

### Execution model
- A `fn` is a **transition**: runs off-chain, consumes/produces records, generates a zkSNARK proof.
- On-chain state changes happen in a `final` block (or `final fn`) the transition returns; a **future** value carries data from transition to finalize.
- Identity operands: `self.caller` (immediate caller), `self.signer` (tx originator). Context: `block.height`, `block.timestamp`, `self.address`, `self.edition`, `self.program_owner`.
- Current Leo v4 syntax: `fn name(...) -> (Outputs, Final) { ... return (out, final { ... }); }`. Older `transition`/`finalize` keywords are outdated — check the installed Leo version's docs before using them.

### Program skeleton
```leo
import credits.aleo;

program my_app.aleo {
    record Entitlement {
        owner: address,
        amount: u64,
    }

    mapping counter: u8 => u64;

    fn mint(private owner: address, private amount: u64) -> (Entitlement, Final) {
        let e: Entitlement = Entitlement { owner, amount };
        return (e, final {
            let c: u64 = Mapping::get_or_use(counter, 0u8, 0u64);
            Mapping::set(counter, 0u8, c + 1u64);
        });
    }

    @noupgrade
    constructor() {}
}
```

### credits.aleo (native token)
1 ALEO = 1_000_000 microcredits. Key functions: `transfer_public`, `transfer_private`, `transfer_public_to_private`, `transfer_private_to_public`, `join`, `split`, `fee_public`, `fee_private`. Every transaction pays a fee; wallet/CLI needs records or public balance to cover it.

## Security checklist (apply to every program)
- **Checked arithmetic by default** — Leo traps on overflow/underflow. Avoid `_wrapped` operators unless wrap-around is intended.
- **Authorize every sensitive transition**: `assert_eq(self.caller, expected)` / `assert_eq(self.signer, expected)`; `signature::verify(sig, addr, msg)` or `ECDSA::verify_keccak256` for meta-transactions. Prefer configurable admin mappings over hardcoded addresses.
- **Replay protection**: records are naturally replay-safe (unique nonces/nullifiers); signed/public operations need a `nonces: address => u64` (or `used_nonces: field => bool`) mapping, validated and incremented atomically in the same `final` block.
- **Privacy leaks**: default inputs/outputs to private; audit every mapping write; beware timing/address correlation even with private records.
- **Front-running**: keep sensitive logic in records; use block-height deadlines; commit-reveal for public operations.
- **Upgrade modes**: `@noupgrade` (immutable), `@admin(address=...)`, `@checksum(mapping=..., key=...)` (DAO-gated), `@custom`. Pick deliberately; audit the constructor.
- **snarkVM hard limits**: program size 512 KB; 31 mappings; 31 entry functions; 310 structs/records; 16 inputs and 16 outputs per entry point; 768 KB max tx; 100 ALEO max on-chain microcredits per tx. Split functionality across programs when approaching these.

## Testing
- Built-in framework: `@test` and `@should_fail` annotations run against the real VM including finalize (`leo test`).
- Cover: every entry function, boundary values (0, max), unauthorized access, double-spend, overflow/underflow, invalid signatures.
- Useful commands: `leo build`, `leo run <fn> <inputs>`, `leo test`, `leo deploy`, `leo execute`. Verify hashes/keys off-chain against `leo run` known vectors before relying on them.

## TypeScript client integration (`@provablehq/sdk`)

### Network selection
Import from `@provablehq/sdk/testnet.js` or `/mainnet.js` — the browser bundles resolve automatically under browser conditions. Key classes: `Account`, `AleoNetworkClient`, `ProgramManager`, `AleoKeyProvider`. Call `await initThreadPool()` once before proving in Node.

### Executions
`ProgramManager.execute({ programName, functionName, inputs, priorityFee, privateFee, program?, imports? })`. Inputs are **plaintext literal strings** (`"123field"`, `"5u64"`, `"{ a: 1u8, b: true }"`, record plaintexts). **Dynamic call targets** (e.g. a token program reached via `program_id.fn()` with a runtime identifier) are not static imports — their sources must be passed explicitly via `imports` or proving fails.

### Record scanning (Node, no wallet)
`findUnspentRecords` walks the chain backwards in 50-block HTTP requests and the public explorer rate-limits (429) and flakes (5xx, `TypeError: fetch failed` = network-level failure, not an HTTP error). Wrap `getBlockRange`/`getLatestHeight`/`getTransitionId` with a pacing gate (~250 ms interval), retry with exponential backoff, cache the latest height, and scan in windows stopping at the first match. In browsers prefer wallet records (below) — scanning is slow and fragile.

### Hashing parity (mapping keys, signed messages)
- Off-chain `BHP256().hash(Plaintext.fromString(p).toBitsLe())` equals on-chain `BHP256::hash_to_field(value)` **only if struct members are serialized in declaration order**. Verify against `leo run` with a known vector before trusting derived keys.
- Wallet `signMessage` **cannot** reproduce `PrivateKey.signValue(field)` semantics (field bits are not byte-aligned); on-chain `signature::verify` over a hashed struct therefore needs an off-chain key or a contract redesign.

## Browser wallet integration (`@provablehq/aleo-wallet-adaptor-*`)

### Stack
`aleo-wallet-adaptor-react` (+ `-react-ui`, `-core`), `aleo-wallet-standard`, `aleo-types`, and per-wallet adapters (`-shield`, `-puzzle`, `-fox`). Wrap the app in `AleoWalletProvider` (wallets, `network: Network.TESTNET`, `decryptPermission: DecryptPermission.UponRequest`, `programs: [...]`) + `WalletModalProvider`; use `useWallet()` and `WalletMultiButton`.

### Patterns that work
- **Records**: `requestRecords(program, false)` → keep `spent === false` → `decrypt(recordCiphertext)` → collapse whitespace to single-line plaintext → select by regex (`microcredits:\s*(\d+)u64`, `amount:\s*(\d+)u128`). Record plaintexts carry **no record name** — distinguish record types structurally (unique members) or by program.
- **Transactions**: `executeTransaction({ program, function, inputs, fee, privateFee })` (fee in microcredits); poll `transactionStatus(txId)`, fall back to `AleoNetworkClient.waitForTransactionConfirmation`. Deploy via `executeDeployment({ program, address, priorityFee, privateFee })`.
- **Vite config gotchas** (all required):
  - `optimizeDeps: { exclude: ["@provablehq/sdk"], include: ["core-js/proposals/json-parse-with-source.js"] }` — without the include, the excluded SDK's CJS core-js import crashes the browser with `require is not defined`.
  - `build.target: "esnext"` (wasm init uses top-level await).
  - COOP/COEP headers (`same-origin` / `require-corp`) and `worker: { format: "es" }` for wasm threads.
  - `server.fs.allow: [".."]` if importing program sources (`*.aleo?raw`) or shared SDK code outside the app root.
- The wallet proves transactions itself and resolves program imports from the network — dynamic token calls that needed explicit `imports` in Node just work, but test this first in a new integration.

## IARC22 / compliant tokens (ARC-20/ARC-22 family)
- Compliant transfers require a **Sealance Merkle exclusion proof** that the sender is not on the freeze list: fetch `https://api.explorer.provable.com/v2/<network>/programs/<token>_freezelist.aleo/compliance/freeze-list`, then with `SealanceMerkleTree` from the SDK: `convertTreeToBigInt` → `getLeafIndices` → `getSiblingPath(tree, idx, 16)` → `formatMerkleProof([left, right])` yields the single `[iarc22::MerkleProof; 2]` plaintext input.
- Price/fee attestations signed by an admin key: reproduce the on-chain message as `BHP256::hash_to_field(struct)` off-chain and `PrivateKey.signValue`; verify with `Signature.verifyValue`.

## Reference links
- Leo docs: `https://docs.leo-lang.org/` (language, guides/finalization, upgradability, deploy/execute, leo-examples on GitHub)
- Aleo docs: `https://docs.aleo.org/` (concepts, Aleo instructions reference, cryptography)
- Standards: ARC-0020 / ARC-0022 at `https://vote.aleo.org/`
- Repos: `github.com/ProvableHQ/{snarkVM,snarkOS,sdk,leo-examples,workshop,ARCs}`
- Security: Trail of Bits snarkVM/snarkOS audits (2022, 2023); Aleo Immunefi bug bounty
- Note: docs.leo-lang.org and docs.aleo.org sit behind Cloudflare bot checks — use a bypass-capable fetch (e.g. a real-user-agent client) when reading them programmatically.
