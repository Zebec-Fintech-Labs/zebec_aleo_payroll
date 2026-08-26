# Fetching Payroll Streams On-Chain (Production Guide)

How to discover and read **public** and **private** payroll streams created by
`test_zebec_payroll_v8.aleo` from the browser, via the Shield wallet
(`app/src/payroll/WalletPayrollService.ts`) and `AleoNetworkClient` mapping
reads.

---

## 1. Where stream state lives

The program is a hybrid: coordination state is public in mappings; sensitive
state lives in encrypted records owned by the participants.

### Public (readable by anyone)

| Mapping | Key | Value | Written by |
| --- | --- | --- | --- |
| `stream_anchors` | `stream_id: field` | `StreamAnchor` | every create/lifecycle fn |
| `payrolls` | `stream_id: field` | `Payroll` | `create_stream_public`, `topup_stream_public` only |
| `payroll_configs` | `config: field` | `PayrollConfig` | admin |
| `whitelisted_token_programs` | `BHP256(WhitelistKey)` | `bool` | admin |

`StreamAnchor` (declaration order matters — see §5):

```
stream_id: field, start_time: i64, duration: u64,
paused: bool, canceled: bool, canceled_at: i64,
deposited_amount: u128, last_paused_time: i64, paused_interval: u64,
withdrawn_amount: u128, is_public: bool, created_timestamp: i64,
initialized: bool
```

`Payroll` (public streams only):

```
stream_id: field, config: field, sender: address, receiver: address,
full_amount: u128, token_program: identifier,
is_cancelable: bool, is_pausable: bool, auto_withdrawable: bool,
can_topup: bool, topup_count: u64, initialized: bool
```

**Key point:** even for *private* streams the `stream_anchors` entry exists and
is public — but it deliberately omits sender, receiver, salary, schedule, and
token program. Only existence + status (`paused`, `canceled`,
`deposited_amount`, `withdrawn_amount`) leak. The sensitive fields live only in
encrypted ticket records.

### Private (encrypted records)

Every stream mints three ticket records at creation, distinguished by
`ticket_type`:

| Record | `ticket_type` | Owner | Holds |
| --- | --- | --- | --- |
| `SenderPayrollTicket` | 0 | employer | receiver, full_amount, permissions, topup_count |
| `ReceiverPayrollTicket` | 1 | employee | sender, full_amount, auto_withdrawable |
| `WithdrawerPayrollTicket` | 2 | authorized withdrawer | both addresses, full_amount |

Lifecycle behavior to keep in mind when reading state:

- `withdraw_stream_private` / `withdraw_stream_auto_private` consume and
  re-emit the receiver/withdrawer ticket (**new nonce each time** — old
  ciphertexts stay on chain forever as spent records).
- `pause_resume_stream_private` re-emits the sender ticket unchanged.
- `topup_stream_private` re-emits the sender ticket with `topup_count + 1`.
- `cancel_stream_private` **burns** the sender ticket; the receiver/withdrawer
  tickets remain unspent but inert (every lifecycle entry asserts
  `!canceled` from the anchor).
- Public-mode lifecycle functions write only to mappings — no records move.

---

## 2. Fetching a known public stream

If you know the `stream_id` (a `field`), everything is two mapping reads plus
off-chain math. No keys required.

```ts
import { AleoNetworkClient } from "@provablehq/sdk/mainnet.js"; // or /testnet.js
import {
  parseStreamAnchor, parsePayroll, computeWithdrawableAmount,
} from "../sdk/index.js";

const client = new AleoNetworkClient(network);
const PROGRAM = "test_zebec_payroll_v8.aleo";
const key = `${streamId}field`; // plaintext literal form

const anchor = parseStreamAnchor(
  await client.getProgramMappingValue(PROGRAM, "stream_anchors", key),
);

if (anchor.isPublic) {
  const payroll = parsePayroll(
    await client.getProgramMappingValue(PROGRAM, "payrolls", key),
  );
}

// Live amounts (sdk/math.ts): elapsed = min(now,end) - start - paused_durations
// withdrawable = rate * elapsed - withdrawn
const { withdrawable } = computeWithdrawableAmount(anchor, nowSec);
```

Equivalent one-liners already exist in `WalletPayrollService`
(`app/src/payroll/WalletPayrollService.ts:503+`):
`getStreamAnchor(id)`, `getPayroll(id)`, `getWithdrawableAmounts(id)` — plus
program previews for local/off-chain queries:
  `view fn get_payroll(field) -> Payroll`, `view fn get_stream_anchor(field) -> StreamAnchor`

For **listing** public streams, see §4 — mappings are not iterable on-chain.

---

## 3. Fetching a private stream

Private streams need two things per participant:

1. **Anchor** — same public mapping read as §2 (status only).
2. **Ticket record** — decrypted with the owner's view key; this is where
   `full_amount`, counterparty, and permissions come from. Without the ticket
   you cannot reconstruct the vesting curve for a private stream.

### 3. Browser (Shield wallet)

Records-via-wallet pattern (`WalletPayrollService.decryptProgramRecords`, line 592):

```ts
const envelopes = await wallet.requestRecords(PROGRAM, false); // false = include plaintext filter
for (const e of envelopes.filter((e) => e.spent === false)) {
  const text = (await wallet.decrypt(e.recordCiphertext))
    .replace(/\s+/g, " ").trim();           // single-line plaintext
}
```

Then classify structurally (decrypted plaintexts carry no record name):

```ts
const type = Number(text.match(/ticket_type:\s*(\d+)u8/)?.[1]);   // 0|1|2
const sid  = text.match(/stream_id:\s*(\d+)field/)?.[1];
```

Existing helpers: `findTicket(recordName, streamId)` (line 658) and
**`listMyTickets()`** (line 676) which enumerates every unspent ticket the
wallet owns — the closest thing today to "list my streams" for employees.

Notes:

- The wallet proves ownership via its GraphKey internally; never handle raw view keys in the browser.
- Always filter `spent === false`: consumed tickets (e.g. after every private
  withdrawal) still decrypt fine and will double-count if included.
- Pick the highest-value credit/token record covering the minimum, not merely
  the first (`findCredits` line 613).

---

## 4. Discovering streams (the current gap)

There is **no on-chain enumeration**: mappings are not iterable, and
`stream_id` is a fresh random `field` per stream. Discovery options, in order
of recommendation for production:

1. **Your own registry (recommended).** At creation time, persist
   `(stream_id, role, mode, txId, parties)` in your backend DB. This is the
   only scalable way to list streams across many employers/employees.
   Optionally mirror it on-chain in an index mapping later
   (`user_streams: address => [stream_id]` style) if public discoverability is
   acceptable — note that leaks recipient↔employer linkage, so do not do this
   for private-mode streams.
2. **Wallet-held tickets** (`listMyTickets()`) — lists all private streams
   where the connected wallet is a participant.
3. **Chain-walking indexer (fallback/compliance).** Every create emits
   transitions visible in blocks; a full-node indexer can extract
   `finalize_create_stream` writes to `stream_anchors`. For public streams the
   `payrolls` entries give full detail; for private streams you can index
   `(stream_id → anchor status)` but **cannot** recover parties or amounts —
   by design. Respect the privacy model: any indexer must not attempt to
   correlate private-stream timing/addresses into a public UI.

---

## 5. Reconstructing live state correctly

Given `anchor` (+ `payroll` for public, or the decrypted ticket for private):

```
end_time   = start_time + duration + banked paused extensions
elapsed    = min(now, end_time) - start_time - paused_interval(s)
accrued    = rate_per_sec * elapsed            // rate = amount / duration
withdrawable = accrued - withdrawn_amount      // capped by funded buffer
```

Reference implementation: `computeWithdrawableAmount` (`sdk/math.ts`),
exposed as `getWithdrawableAmounts(streamId, now?, fullAmount?)` in
`WalletPayrollService`. Accrual is uncapped; the payout is capped at the funded
remainder (`deposited_amount - withdrawn_amount`) — for buffer-mode streams,
accrued-but-unfunded amounts stay locked until a top-up — surface that in UI
rather than letting the tx revert.

Rules that will bite you if ignored:

- **Struct member order is consensus-critical.** Mapping values and signed
  structs are hashed as bits in Leo declaration order
  (`BHP256::hash_to_field`). Never reorder fields in `sdk/plaintext.ts`
  emitters/parsers without regenerating vectors and redeploying considerations.
- **Private lifecycle fns take caller-supplied anchor snapshots** asserted
  equal on-chain (`assert_stream_anchor_eq`). Always fetch the anchor
  immediately before building the tx; a stale snapshot fails the proof after
  you've paid synthesis fees.
- **Spent vs unspent**: always exclude spent tickets; each withdrawal rotates
  the receiver ticket's nonce.
- **Cancelled streams**: sender ticket no longer exists; receiver/withdrawer
  tickets decrypt but every entry asserts `!canceled` — read `canceled` from
  the anchor before offering any action.

---

## 6. Quick reference

| Task | Tool |
| --- | --- |
| Read anchor / payroll by id | `getProgramMappingValue` + `parseStreamAnchor` / `parsePayroll` |
| Preview amounts | `getWithdrawableAmounts(streamId)`, `view fn get_payroll` |
| Find my tickets | `wallet.requestRecords(prog, false)` → decrypt → classify `ticket_type` |
| List all streams for a user | backend registry keyed at creation (§4.1) |
| Token/config checks | `isTokenWhitelisted`, `getPayrollConfig` |
