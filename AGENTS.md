# Agents helper

<!-- BEGIN: Aleo Docs -->
## 1. Background and Concepts of the Aleo Chain

Aleo is a Layer-1 blockchain built from the ground up for privacy-preserving applications. Its slogan, "zero-knowledge by design," captures the idea that developers do not bolt privacy onto an existing transparent virtual machine; instead, privacy is a first-class primitive of the execution model.

The Aleo stack consists of three major components:

- **snarkVM**: The zero-knowledge virtual machine that compiles Aleo programs, generates zkSNARK proofs, and verifies them. It is the execution layer for all Aleo transactions.
- **snarkOS**: The decentralized operating system that runs the network, stores encrypted application state, propagates transactions, and produces blocks.
- **Leo**: A statically typed, Rust-like high-level language that compiles to Aleo Instructions, the low-level bytecode executed by snarkVM.

An Aleo account is a hierarchical family of keys derived from a single seed. The key formats are Bech32-encoded strings with the following prefixes:

| Key | Prefix | Purpose |
| ----- | -------- | --------- |
| Private key | `APrivateKey1...` | Signs transactions and derives all other keys |
| View key | `AViewKey1...` | Decrypts records owned by the account |
| Address | `aleo1...` | Public identifier used as record owner or mapping key |
| Signature | `sign1...` | Schnorr signature produced by the private key |

Starting from a random seed, the private key derives two scalars via domain-separated Poseidon hashes. These produce the signature public key and a randomizer, which in turn yield a PRF key. The view key is the sum of the signature secret, the randomizer, and the PRF key. The address is the group sum of the corresponding public points.

Records are encrypted to their owner using an ECDH-like shared secret. A record includes a nonce `nonce = G^r` for randomizer `r`. The owner computes:

```
record_view_key = (nonce * view_key).x
```

Only the owner's view key can derive this value, so only the owner can decrypt the record plaintext. A separate **GraphKey** allows a wallet to scan the chain for owned records without exposing the full view key to a remote service. This is important for light clients and delegated scanning services.

Aleo programs can store state in two fundamentally different ways:

**Records (private state)** are UTXO-like objects. Each record has an `owner: address` and arbitrary application-defined fields, plus protocol fields `_nonce: group` and `_version: u8`. Records are created as outputs and consumed as inputs; once consumed, they cannot be spent again. Record contents are encrypted on-chain and readable only by the owner.

**Mappings (public state)** are key-value stores declared at program scope and updated only inside `finalize` blocks. Mapping keys and values are visible to everyone. They behave like the storage mappings in Ethereum.

| Property | Records | Mappings |
| --- | --- | --- |
| Visibility | Encrypted, owner-readable | Public |
| Mutation model | Consumed and recreated | Updated in place |
| Execution context | Off-chain proof | On-chain finalize |
| Best for | Private balances, entitlements, credentials | Public counters, registries, configs |

A well-designed Aleo application chooses the right state model for each piece of data. In a payroll program, salary amounts and employee addresses should live in records; global coordination data such as a whitelist of accepted tokens can live in mappings.

An Aleo program is declared with a `program {name}.aleo` block. It contains records, mappings, structs, and functions. In current Leo (v4.x), the entry points are declared with `fn`, and on-chain state updates are performed inside `final` blocks or `final fn` helpers.

A typical pattern is:

```leo
program payroll.aleo {
    mapping stream_count: u64 => u64;

    fn create_stream(public employee: address, public rate: u64) -> Final {
        return final {
            let current: u64 = Mapping::get_or_use(stream_count, 0u64, 0u64);
            Mapping::set(stream_count, 0u64, current + 1u64);
        };
    }
}
```

The off-chain portion of the function is the **transition**. It consumes and produces records and generates a zkSNARK proof. The on-chain portion is the **finalize** block, which updates mappings. A transition can return a **future**, an opaque value that must be awaited by the matching finalize.

Two important identity operands are available:

- `self.caller`: the immediate caller of the function.
- `self.signer`: the top-level transaction signer.

Contextual values include `block.height`, `block.timestamp`, `self.address`, `self.edition`, and `self.program_owner`.

`credits.aleo` is Aleo's native token program. One ALEO equals 1,000,000 microcredits. It exposes the following important functions:

- `transfer_public(to, amount)`: moves public balance between accounts.
- `transfer_private(record, to, amount)`: consumes a private credits record and creates receiver and change records.
- `transfer_public_to_private(to, amount)`: converts public balance into a private record.
- `transfer_private_to_public(record, to, amount)`: converts a private record into public balance.
- `join`, `split`: record management functions.
- `fee_public`, `fee_private`: fee payment from public or private balance.

Any payroll program on Aleo will likely interact with `credits.aleo` for fee payment and possibly for native-currency salary streams. For stablecoin-denominated payroll, the program would interact with a custom token program similar to the standard `token.aleo` example.

These links has cloudflare bot check. Use some means to bypass them.

- `https://docs.aleo.org/learn/what-is-aleo/background`
- `https://docs.aleo.org/learn/what-is-aleo/how-aleo-works`
- `https://docs.aleo.org/learn/core-concepts/public-and-private-state`
- `https://docs.aleo.org/learn/core-concepts/accounts-and-keys`
- `https://docs.aleo.org/learn/core-concepts/programs`
- `https://docs.aleo.org/learn/core-concepts/transactions`
- `https://docs.aleo.org/learn/core-concepts/credits-and-transfers`
- `https://docs.aleo.org/learn/network/architecture`
- `https://docs.aleo.org/learn/network/consensus`
- `https://docs.aleo.org/learn/network/tokenomics`
- `https://docs.aleo.org/learn/network/nodes/validators`
- `https://docs.aleo.org/learn/network/nodes/provers`
- `https://docs.aleo.org/learn/network/nodes/clients`
- `https://docs.aleo.org/learn/advanced/cryptography/zksnarks`
- `https://docs.aleo.org/learn/advanced/cryptography/the-aleo-curves`
- `https://docs.aleo.org/learn/advanced/key-derivation`
- `https://docs.aleo.org/learn/advanced/transitions`
- `https://docs.aleo.org/learn/advanced/record-scanning`
- `https://docs.aleo.org/learn/advanced/delegated-proving`
- `https://docs.aleo.org/learn/reference/specifications`
- `https://docs.aleo.org/learn/reference/security-audits`
- `https://docs.aleo.org/build/aleo-instructions/reference/programs`
- `https://docs.aleo.org/build/aleo-instructions/reference/types`,
- `https://docs.aleo.org/build/aleo-instructions/reference/standard-operations`,
- `https://docs.aleo.org/build/aleo-instructions/reference/cryptographic-operations`,
- `https://docs.aleo.org/build/aleo-instructions/reference/finalize-operations`
<!-- BEGIN: Fungible Token Standards -->
- `https://vote.aleo.org/p/arc-0020`
- `https://vote.aleo.org/p/arc-0022`
<!-- END: Fungible Token Standards -->
- snarkVM repository: `https://github.com/ProvableHQ/snarkVM`
- snarkOS repository: `https://github.com/ProvableHQ/snarkOS`
- Aleo ARCs: `https://github.com/ProvableHQ/ARCs`
- Provable SDK: `https://github.com/ProvableHQ/sdk`
- Marlin zkSNARK: `https://github.com/ProvableHQ/marlin`
- Varuna reference implementation: `https://github.com/ProvableHQ/varuna-sage-impl`
- Aleo HD key derivation: `https://github.com/ProvableHQ/aleo-hd-key`
- Trail of Bits, "Aleo snarkVM Security Review," 2022: `https://github.com/trailofbits/publications/blob/master/reviews/2022-09-aleosystems-snarkvm-securityreview.pdf`
- Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review," 2023: `https://github.com/trailofbits/publications/blob/master/reviews/2023-10-aleo-securityreview.pdf`
- Aleo Immunefi bug bounty: `https://immunefi.com/bug-bounty/aleo/`

<!-- END: Aleo Docs -->

<!-- BEGIN leo-docs -->
## 2. Leo Docs Resources

Read contents from these links. Note: There may be cloudflare check to check if you are bot. Use some means to bypass them if required.

- `https://docs.leo-lang.org/getting_started/installation`
- `https://docs.leo-lang.org/getting_started/hello`
- `https://docs.leo-lang.org/language/overview`
- `https://docs.leo-lang.org/language/layout`
- `https://docs.leo-lang.org/language/structure`
- `https://docs.leo-lang.org/language/data_types`
- `https://docs.leo-lang.org/language/programs_in_practice/private_state`
- `https://docs.leo-lang.org/language/programs_in_practice/public_state`
- `https://docs.leo-lang.org/language/programs_in_practice/functions`
- `https://docs.leo-lang.org/language/programs_in_practice/interfaces`
- `https://docs.leo-lang.org/language/programs_in_practice/intrinsics`
- `https://docs.leo-lang.org/language/programs_in_practice/control_flow`
- `https://docs.leo-lang.org/language/programs_in_practice/limitations`
- `https://docs.leo-lang.org/language/operators`
- `https://docs.leo-lang.org/language/operators/standard_operators`
- `https://docs.leo-lang.org/language/operators/cryptographic_operators`
- `https://docs.leo-lang.org/language/libraries`
- `https://docs.leo-lang.org/language/standard_library`
- `https://docs.leo-lang.org/language/style`
- `https://docs.leo-lang.org/language/cheatsheet`
- `https://docs.leo-lang.org/cli/cli_overview`
- `https://docs.leo-lang.org/guides/overview`
- `https://docs.leo-lang.org/guides/finalization`
- `https://docs.leo-lang.org/guides/dependencies`
- `https://docs.leo-lang.org/guides/workspaces`
- `https://docs.leo-lang.org/guides/deploy`
- `https://docs.leo-lang.org/guides/execute`
- `https://docs.leo-lang.org/guides/sign`
- `https://docs.leo-lang.org/guides/upgradability`
- `https://docs.leo-lang.org/guides/abi`
- `https://docs.leo-lang.org/guides/binary-distribution`
- `https://docs.leo-lang.org/leo_by_example/auction`
- `https://docs.leo-lang.org/leo_by_example/basic_bank`
- `https://docs.leo-lang.org/leo_by_example/vote`
- `https://docs.leo-lang.org/leo_by_example/token`
- `https://docs.leo-lang.org/leo_by_example/tictactoe`
- `https://docs.leo-lang.org/leo_by_example/battleship`
- `https://docs.leo-lang.org/resources/curated`
- `https://github.com/ProvableHQ/workshop`
- `https://provable.com/blog`
- `https://github.com/ProvableHQ/leo-examples/tree/main`

<!-- END leo-docs -->

<!-- BEGIN: Zebec Payroll Docs -->
## 3. Zebec Payroll Docs

Payroll streaming is the continuous release of compensation over time rather than in discrete lump sums. The simplest model is linear vesting:

```
vested(t) = amount * (t - start) / (end - start)
```

capped at the total amount. Employees can withdraw accrued funds at any time. If the employment relationship ends, the stream can be cancelled and the unvested remainder returned to the employer.

The payroll application should have features to stream payroll by an employer (aleo account) to an employee (aleo account). The model is debt based where user may fund the payroll upfront or fund in installments. Either way the payroll should streamed right from the start time. The payroll should have option to initialize the stream right at the execution or from the specified start time which check that ensures the start time has not passed away. Stream should be pausable and cancelable by initiator (sender) if set as pausable and cancelable. If stream start time is passed from the caller but if start now is set then parameters value for start time is ignored and its value is set as timestamps of execution time.

Below is the payroll stream data structure. This payroll stream should have minimum this much information but may not be in a single struct as given below.

```rust
pub struct PaymentStream {
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub stream_token: Pubkey,
    pub full_amount: u64,
    pub deposited_amount: u64,
    pub start_time: i64,
    pub last_withdrawn_timestamp: i64,
    pub withdrawn_amount: u64, 
    pub duration: u64,
    pub paused_timestamp: i64,
    pub paused_interval: i64,
    pub canceled_timestamp: i64,
    pub cancelable: bool,
    pub autowithdraw_frequency: u64, 
    pub auto_withdrawable: bool,
    pub can_topup: bool,
    pub pausable: bool,
    pub covered_until: i64,
    pub topup_count: u64,
}
```

From these protocols and from the local `Payroll.sol` reference implementation, a complete payroll streaming program needs the following features:

1. **Create stream**: define sender, receiver, token, total amount, start time, duration, frequency, cliff, and permissions.
2. **Withdraw**: recipient pulls accrued tokens.
3. **Cancel**: stop the stream and split escrow between recipient (vested) and sender (unvested).
4. **Pause / resume**: freeze accrual and extend the end time by the paused duration.
5. **Top-up**: add funds to extend a stream or repay debt.
6. **Permission toggles**: who can cancel, pause, transfer, or top up.
7. **Cliff**: release a percentage upfront.
8. **Automatic withdrawal**: allow a withdrawer (may be admin himself) to withdraw on the recipient's behalf. transaction fee + platform fee should be calculated at stream creation and transfer to fee vault.
9. **Fee per payroll**: Certain percent of usd worth of streaming amount should be transferred to fee vault at time of payroll stream creation.

Three funding models are common:

**Full upfront escrow**: the sender deposits the entire stream value at creation. This is trust-minimal for the recipient but capital-intensive for the sender.

**Buffer / top-up**: the sender deposits only an initial buffer, then tops up periodically. This matches real-world cash flow but requires debt tracking and solvency monitoring.

**Payer pool / debt**: all streams share a single sender balance. If the balance is depleted, streams enter debt. This is the most capital-efficient but places counterparty risk on recipients.

## 4. Design Space for an Aleo Payroll Program

This section evaluates three high-level architectures for a payroll streaming program on Aleo..

The recommended design stores sensitive state in private records and coordination state in public mappings. Specifically:

**Private records:**

- Treasury record for the employer: token type and remaining budget.
- Employee entitlement record: stream ID, employee address, rate, start time, end time, withdrawn amount, and pause state.
- Payment record: issued to employee upon withdrawal.

**Public mappings:**

- `streams: field => StreamMeta`: non-sensitive metadata such as stream existence, status (active/paused/cancelled), and last update block.
- `whitelisted_tokens: field => bool`: accepted token programs.
- `nonces: address => u64`: replay protection for signed operations.
- `config: u8 => Config`: global settings such as platform fee vault and withdrawal keeper.

**Advantages:**

- Balances privacy and accountability: salaries and recipients stay private, but the program can still enforce global rules.
- Supports both public and private streams by parameterizing visibility at creation time.
- Enables pause/resume/cancel by updating both records and mappings atomically.
- Compatible with both full escrow and buffer/top-up funding.

**Disadvantages:**

- More complex than the pure approaches.
- Requires careful design to avoid privacy leaks at the public/private boundary.
- Developers must understand both records and mappings.

The program should allow the employer to choose, per stream, whether the stream is public or private:

- **Private stream**: salary, recipient, and schedule are hidden in records. Only the existence flag and status are public.
- **Public stream**: amount, recipient, and schedule are stored in mappings. Useful for transparent grants or regulated payroll where disclosure is required.

This dual mode is implemented by having two code paths in `create_stream`, `withdraw`, and `cancel` functions: one that manipulates records and one that manipulates mappings.

| Criterion | A: Fully Private | B: Fully Public | C: Hybrid (Recommended) |
| --- | --- | --- | --- |
| Salary privacy | Maximum | None | Strong |
| Recipient privacy | Maximum | None | Strong |
| Global invariant enforcement | Weak | Strong | Moderate–Strong |
| Pause/resume/cancel complexity | High | Low | Moderate |
| Capital efficiency (top-up) | Poor | Good | Good |
| Front-running resistance | High | Low | Moderate–High |
| Upgrade flexibility | Low | High | Moderate |
| Wallet/UX complexity | High | Low | Moderate |
| Compliance/auditability | Selective disclosure | Full transparency | Selective disclosure |

Pause and resume can be implemented by recording a pause timestamp and accumulating paused duration. When the stream resumes, the end time is extended by the paused duration so that the employee still receives the full contracted amount.

Cancel is terminal. The program computes the vested amount at cancellation time and:

- Transfers the vested amount to the employee.
- Returns the unvested remainder to the employer.
- Marks the stream as cancelled in public state.
- Burns or invalidates the entitlement record.

For private streams, cancellation must be authorized by a party holding the entitlement record or by a pre-authorized keeper.

## 5. Recommended Design and Implementation

The hybrid approach is recommended because it is the only one that satisfies all project requirements simultaneously:

- It supports both public and private streams.
- It allows pause, resume, and cancel.
- It supports full escrow and buffer/top-up funding.
- It uses Aleo's records for privacy and mappings for coordination.
- It can be implemented within snarkVM's limits.

A sketch of the program structure is shown below. This is a design reference, not a production-ready implementation.

```leo
import credits.aleo;

program zebec_payroll.aleo {
    // ------------------------------------------------------------------
    // Records (private state)
    // ------------------------------------------------------------------
    record Treasury {
        owner: address,
        token: address,      // address of the token program
        balance: u64,
        treasury_id: field,
    }

    record Entitlement {
        owner: address,             // employee
        employer: address,
        stream_id: field,
        token: address,
        duration: u64,        // microcredits or token units per block
        start_time: u32,
        end_end: u32,
        withdrawn: u64,
        paused_blocks: u32,
        can_topup: bool,           // false = full escrow, true = buffer/top-up
        buffer_until: u32,          // for top-up mode
        ... 
    }

    record Payment {
        owner: address,
        token: address,
        amount: u64,
        stream_id: field,
    }

    // ------------------------------------------------------------------
    // Public state
    // ------------------------------------------------------------------
    mapping stream_meta: field => StreamMeta;
    mapping whitelisted_tokens: address => bool;
    mapping employer_nonces: address => u64;
    mapping payroll_config: field => Config;

    struct StreamMeta {
        exists: bool,
        is_public: bool,
        status: u8,         // 0 = active, 1 = paused, 2 = cancelled
        created_timestamp: i64,
        // Implemented anchor also carries coordination fields for the
        // private-stream lifecycle: `sender` (authorizes anchor-only
        // pause/resume/cancel/topup), `paused_at` (current pause window)
        // and `banked_paused_secs` (completed pause seconds to be consumed
        // by the employee's next claim).
    }

    struct Config {
        admin: address,
        fee_vault: address,
        keeper: address,
    }

    // ------------------------------------------------------------------
    // Entry functions
    // ------------------------------------------------------------------
    fn create_private_stream(
        treasury: Treasury,
        employee: address,
        total_amount: u64,
        rate_per_block: u64,
        start_time: u32,
        end_time: u32,
        funding_mode: u8,
        buffer_until: u32
    ) -> (Treasury, Entitlement, Final) { ... }

    fn create_public_stream(
        public token: address,
        public employee: address,
        public total_amount: u64,
        public duration: u64,
        public start_time: u32,
        public end_time: u32,
        public start_now: bool,
    ) -> Final { ... }

    fn withdraw_private(
        entitlement: Entitlement,
        amount: u64
    ) -> (Entitlement, Payment, Final) { ... }

    fn withdraw_public(
        public stream_id: field,
        public amount: u64
    ) -> Final { ... }

    fn pause_stream(
        entitlement: Entitlement
    ) -> (Entitlement, Final) { ... }

    fn resume_stream(
        entitlement: Entitlement
    ) -> (Entitlement, Final) { ... }

    fn cancel_private_stream(
        entitlement: Entitlement
    ) -> (Payment, Final) { ... }

    fn cancel_public_stream(
        public stream_id: field
    ) -> Final { ... }

    fn topup_private_stream(
        treasury: Treasury,
        entitlement: Entitlement,
        amount: u64
    ) -> (Treasury, Entitlement, Final) { ... }

    fn topup_public_stream(
        public stream_id: field,
        public amount: u64
    ) -> Final { ... }

    @noupgrade
    constructor() {}
}
```

**Full upfront escrow.** When creating a private stream with `funding_mode = 0`, the employer's treasury record is reduced by the full `total_amount`, and the entitlement record is created with that amount as its notional value. The program does not need solvency checks during withdrawals because the funds are already locked.

**Buffer / top-up.** When creating a private stream with `funding_mode = 1`, only an initial buffer is moved from the treasury record to the entitlement record. The `buffer_until` field records the block height up to which the buffer is funded. The employer calls `topup_private_stream` periodically to extend `buffer_until`. If a withdrawal is requested beyond the funded buffer, the transition fails, and the employee must wait for a top-up.

The`initialBufferDuration` determines the proportional initial deposit and `coveredUntil` tracks the funded horizon.

Aleo provides both `block.height` and `block.timestamp`.
For payroll denominated in seconds or days, the off-chain client can convert using the expected block time, or the program can use `block.timestamp` for human-readable schedules while accepting the small manipulation risk.
But we'll proceed with use of block timestamp.

Access control in Leo uses `self.caller` and `self.signer`:

- Only the employer (treasury record owner) can create streams.
- Only the employee (entitlement record owner) can withdraw, unless a keeper is authorized.
- Pause and resume require authorization from either party depending on the stream's permission flags.
- Cancel requires authorization from a permitted party.

For meta-transactions, the program can verify Schnorr signatures with `signature::verify(sig, addr, msg)` or ECDSA signatures with `ECDSA::verify_keccak256`. This allows a relayer to submit transactions on behalf of an employee who signs off-chain.

Because records are UTXO-like, every operation that spends a record must produce change outputs. For example, withdrawing from an entitlement record consumes it and produces a smaller entitlement record plus a payment record. Failure to return change would destroy unspent value.

Employers with many employees will accumulate many small entitlement records. The program or an accompanying utility can provide a `consolidate` function that merges entitlement records for the same employee, similar to `credits.aleo::join`.

The accrued amount at block timestamp `t` is computed as:

```
elapsed = min(t, end_time) - start_time - paused_durations
accrued = rate * elapsed
withdrawable = accrued - withdrawn
```

All arithmetic uses Leo's checked operators, so overflow or underflow causes the proof to fail.

For public streams, the same calculation is performed in the finalize block using mapping values. For private streams, the calculation happens off-chain in the transition, and the proof only asserts that the withdrawn amount does not exceed the accrued amount.

To fully utilize Aleo's capabilities, the payroll program should integrate the following advanced features:

**Delegated proving.** zkSNARK proof generation is computationally expensive. Employers and employees can build authorizations locally and send them to a delegated prover service, which returns a finished proof without ever seeing the private key. This lowers the hardware barrier for end users while preserving custody.

**Record scanning and GraphKeys.** Wallets discover owned records by scanning encrypted chain data. Employees can use their GraphKey to query a record-scanning service without exposing their full ViewKey. Employers can use local scanning with the ViewKey to enumerate treasury and entitlement records for top-up and consolidation operations.

**Private-to-public and public-to-private conversions.** Employees who want to spend streamed tokens in public DeFi can call `transfer_private_to_public` on the token program. Employers who receive public revenue can convert public balance into private payroll budget records via `transfer_public_to_private`.

**View functions.** The program can expose `view fn` endpoints that let authorized parties compute accrued amounts off-chain without submitting transactions. For example, a `view fn preview_withdrawal(entitlement)` could return the withdrawable amount for wallet display.

**Program composability via interfaces.** If multiple token programs implement a common token interface, the payroll program can accept any compliant token by dynamic dispatch. This avoids hardcoding a single stablecoin program and improves interoperability.

**Selective disclosure and compliance proofs.** An employer can generate a zero-knowledge proof that total monthly payouts are within budget or that all recipients are whitelisted, without revealing individual salaries. This satisfies compliance requirements while preserving confidentiality.

**Record autojoin and consolidation.** Wallets or helper programs can merge multiple small payment records into a single larger record, reducing the number of inputs required for future transactions. This is the private-state equivalent of consolidating UTXOs.

Payroll programs on Aleo incur three types of costs:

1. **Storage cost:** proportional to transaction byte size, including encrypted records.
2. **Finalize cost:** proportional to on-chain mapping operations.
3. **Proof synthesis cost:** one-time per transaction for generating the zkSNARK.

Private transfers are generally more expensive in proof synthesis but cheaper in finalize because they avoid public mapping writes. Public streams resemble EVM gas costs: each withdrawal updates mappings on-chain. The program should minimize finalize operations for high-frequency actions.

UX implications:

- Employees need wallets that support record scanning and input selection.
- Employers need tooling to manage treasury records and schedule top-ups.
- Relayers can sponsor fees for employees who do not hold ALEO, using signature-based meta-transactions.
- Proof generation latency may require delegated proving for a smooth mobile experience.

## 6. Security Considerations

Leo defaults to checked arithmetic. The report recommends relying on this behavior for all financial calculations and avoiding `_wrapped` operators unless wrap-around is explicitly intended. The token example in the Leo workshop relies on checked subtraction to ensure that transfers cannot overdraw a balance.

Every sensitive transition must assert authorization before mutating state. Recommended checks include:

- `assert_eq(self.caller, expected_address)` for direct authorization.
- `assert_eq(self.signer, expected_address)` when the transaction originator must be the owner.
- `signature::verify(sig, addr, msg)` for off-chain authorization.
- Hardcoded admin addresses only for simple deployments; production systems should use `@checksum` governance or multi-signature constructors.

Records are naturally replay-resistant because each has a unique nonce and is consumed via a nullifier. For public operations that rely on signatures or nonces, the program must maintain a `nonces: address => u64` mapping or a `used_nonces: field => bool` mapping. The nonce must be validated and incremented atomically inside the same finalize block.

The biggest security risk in a hybrid program is accidentally leaking private data through public state. Guidelines:

- Default all inputs and outputs to private.
- Do not store salary amounts, employee addresses, or stream schedules in public mappings unless the stream is explicitly public.
- Avoid private-to-public transfers that reveal the receiver and amount.
- Be aware that timing and address correlation can de-anonymize users even when individual records are private.

Public state updates can be front-run. Mitigations include:

- Keeping sensitive logic in private records.
- Using block-height deadlines for time-sensitive operations.
- Using commit-reveal schemes for public operations that should not be observable in advance.

Leo supports four upgrade modes via the constructor:

- `@noupgrade`: permanently immutable.
- `@admin(address=...)`: single admin can upgrade.
- `@checksum(mapping=..., key=...)`: upgrade gated by an on-chain approved checksum.
- `@custom`: fully custom logic.

For payroll, `@noupgrade` gives employees certainty that rules cannot change, while `@checksum` allows bug fixes under DAO governance. The constructor logic is immutable after first deployment, so it must be audited with special care.

snarkVM enforces hard limits that affect design:

- Max compiled program size: 512 KB.
- Max mappings: 31.
- Max entry functions: 31 per program.
- Max structs / records: 310 each.
- Max inputs/outputs per entry point: 16 each.
- Max transaction size: 768 KB.
- Max on-chain microcredits per transaction: 100,000,000.

A production payroll program may need to split functionality across multiple programs if it approaches these limits.

Leo provides a built-in test framework using `@test` and `@should_fail` annotations. Tests execute against the real VM, including finalize blocks. The report recommends:

- Unit tests for every entry function.
- Boundary tests for zero amount, maximum amount, unauthorized access, and double spending.
- `@should_fail` tests for overflow, underflow, and invalid signatures.
- Local devnet testing before testnet deployment.
- External audit focused on the constructor, access control, and public/private boundary.

Public security references for the Aleo stack include Trail of Bits audits of snarkVM and snarkOS (2022 and 2023) and the Aleo Immunefi bug bounty.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Integer overflow/underflow | Low | High | Use checked arithmetic; test boundary conditions |
| Unauthorized withdrawal | Low | High | `self.caller` / `self.signer` checks; signature verification |
| Replay of signed operations | Low | High | Atomic nonce mapping updates |
| Privacy leak via public state | Medium | High | Default private; audit mapping writes |
| Front-running public operations | Medium | Medium | Private records; block-height deadlines |
| Program limit exhaustion | Low | Medium | Split large programs; respect snarkVM limits |
| Malicious upgrade | Low | High | `@noupgrade` or `@checksum` governance; audit constructor |
| Record loss due to missing change | Medium | High | Always return change records; test all code paths |
| Proof generation failure | Low | Medium | Use delegated proving; test with realistic inputs |

<!-- END: Zebec Payroll Docs -->
<!-- BEGIN: Browser app -->
## 7. Browser app (`app/`)

`app/` is a React + Vite browser app that replaces the private-key CLI flows
(`scripts/`) with wallet-based execution via the Shield wallet and the
`@provablehq/aleo-wallet-adaptor-*` packages. See `app/README.md` for details.

- Commands: `cd app && yarn install`, `yarn dev`, `yarn build` (`tsc && vite
  build`), `yarn preview`.
- Architecture: `app/src/payroll/WalletPayrollService.ts` is the wallet-backed
  counterpart of `sdk/client.ts`'s `PayrollService` — transactions go through
  the wallet's `executeTransaction` / `executeDeployment` (never
  ProgramManager), mapping reads through `AleoNetworkClient`. It imports the
  SDK's pure modules (`sdk/plaintext.ts`, `sdk/hashing.ts`, `sdk/math.ts`,
  `sdk/signing.ts`, `sdk/types.ts`) by relative path; it must NOT import
  `sdk/client.ts` or `sdk/records.ts`.
- Records-via-wallet pattern: `requestRecords(program, false)` → keep
  `spent === false` → `wallet.decrypt(recordCiphertext)` → single-line
  plaintext → pick highest `microcredits:`/`amount:` record covering the
  needed amount; payroll tickets are matched structurally (ported
  `matchesTicket` logic).
- The only private key in the app is the admin attestation key input on the
  Employer page, used solely for `signTokenPrice` (never persisted).
<!-- END: Browser app -->
