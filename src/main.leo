import credits.aleo;

struct MerkleProof {
    siblings: [field; 16],
    leaf_index: u32,
}

interface IARC22 {
    record Token {
        owner: address,
        amount: u128,
        ..
    }

    record ComplianceRecord {
        owner: address,     // INVESTIGATOR_ADDRESS
        amount: u128,
        sender: address,    // ZERO_ADDRESS for mint paths
        recipient: address, // ZERO_ADDRESS for burn paths
        .. 
    }

    //=============================================================
    //               APPROVAL FUNCTIONS
    //=============================================================
    fn approve_public(public spender: address, public amount: u128) -> Final;
    fn unapprove_public(public spender: address, public amount: u128) -> Final;

    //=============================================================
    //               TRANSFER FUNCTIONS
    //=============================================================
    fn transfer_public(public recipient: address, public amount: u128) -> Final;
    fn transfer_private(
        private recipient: address,
        private amount: u128,
        private input_record: Token,
        private sender_merkle_proofs: [MerkleProof; 2u32],
    ) -> (ComplianceRecord, Token, Token, Final);
    fn transfer_private_to_public(
        public recipient: address,
        public amount: u128,
        private input_record: Token,
        private sender_merkle_proofs: [MerkleProof; 2u32],
    ) -> (ComplianceRecord, Token, Final);
    fn transfer_public_to_private(recipient: address, public amount: u128) -> (
        ComplianceRecord, Token, Final,
    );
    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final;
    fn transfer_from_public_to_private(
        public owner: address,
        private recipient: address,
        public amount: u128,
    ) -> (ComplianceRecord, Token, Final);
    fn transfer_public_as_signer(public recipient: address, public amount: u128) -> Final;

    //=============================================================
    //               JOIN/SPLIT FUNCTIONS
    //=============================================================
    fn join(input_1: Token, input_2: Token) -> Token;
    fn split(input: Token, amount: u128) -> (Token, Token);

    //=============================================================
    //                VIEW FUNCTIONS
    //=============================================================
    view fn balance_of(account: address) -> u128;
    view fn allowance(owner: address, spender: address) -> u128;
    view fn supply() -> u128;
    view fn max_supply() -> u128;
    view fn decimals() -> u8;
    view fn name() -> identifier;
    view fn symbol() -> identifier;
}

// A single fee tier. `min_amount`/`max_amount` are USD values with
// 6 decimals; `fee` is the fee in basis points charged for stream amounts
// whose USD value falls in `(min_amount, max_amount]`.
struct FeeTier {
    min_amount: u64,
    max_amount: u64,
    fee_bps: u64,
}

// Identifies one fee tier slot of one payroll config. Hashed with BHP256 to
// form the `fee_tiers` mapping key.
struct FeeTierKey {
    config: field,
    index: u8,
}

// Identifies one whitelisted token of one payroll config. Hashed with BHP256
// to form the `whitelisted_tokens` mapping key.
struct WhitelistKey {
    config: field,
    token_program: identifier,
}

// Program configuration. Multiple config live in this program's
// `payroll_configs` mapping, each under a unique config name. Fee tiers and
// whitelisted tokens are stored per config in separate mappings (see
// `FeeTierKey` / `WhitelistKey`).
struct PayrollConfig {
    admin: address,
    fee_vault: address,
    withdrawer: address,
    base_fee: u64,
    platform_fee: u64,
    initialized: bool,
}

struct Payroll {
    stream_id: field,
    // Config (tenant) the stream was created under.
    config: field,
    sender: address,
    receiver: address,
    full_amount: u128,
    token_program: identifier,
    is_cancelable: bool,
    is_pausable: bool,
    auto_withdrawable: bool,
    can_topup: bool,
    topup_count: u64,
    initialized: bool,
}

struct StreamAnchor {
    stream_id: field,
    start_time: i64,
    duration: u64,
    paused: bool,
    canceled: bool,
    canceled_at: i64,
    deposited_amount: u128,
    covered_until: i64,
    last_paused_time: i64,
    paused_interval: u64,
    withdrawn_amount: u128,
    is_public: bool,
    created_timestamp: i64,
    initialized: bool,
}

struct CreateStreamParams {
    receiver: address,
    // Randomness for the stream id.
    stream_id: field,
    amount: u128,
    start_time: i64,
    duration: u64,
    is_cancelable: bool,
    is_pausable: bool,
    auto_withdrawable: bool,
    withdraw_frequency: u64,
    start_now: bool,
    can_topup: bool,
    // Token amount for the initial pre-paid buffer window.
    // When can_topup is true, then the initial_buffer_amount 
    // is take as buffer amount
    initial_buffer_amount: u128,
}

struct TokenPrice {
    // Config this price is signed for. Binds the admin's signature to one
    // payroll config so it cannot be replayed against another config.
    config: field,
    // Stream token: field,
    stream_token: identifier,
    // Admin-signed token price in USD (6 decimals).
    stream_token_price_usd: u64,
    // Aleo price in USD (6 decimals)
    aleo_price_usd: u64,
    // Unix timestamp after which the signed price is no longer valid.
    price_expiry: i64,
    // Unique nonce,
    nonce: field,
}

struct Config {
    config_name: field,
    admin: address,
    fee_vault: address,
    withdrawer: address,
    base_fee: u64,
    platform_fee: u64,
}



// Usd price decimal scale. Used to resolve floating point value of price
// by multiplying price by this scale.
const USD_PRICE_DECIMALS_SCALE: u64 = 1_000_000u64;

// Bps Denominator
const BPS_DENOMINATOR: u64 = 10_000u64;

// Maximum number of fee tiers supported per payroll config.
const MAX_FEE_TIERS: u8 = 8u8;

// Maximum u64 value, widened to u128 for range checks on widened arithmetic.
const U64_MAX: u128 = 18_446_744_073_709_551_615u128;

// Maximum i64 value, widened to u128 for range checks on widened arithmetic.
const I64_MAX: u128 = 9_223_372_036_854_775_807u128;

// Fallback withdraw frequency (1 day) used as a guarded divisor when
// auto-withdrawal is disabled (Leo flattens branches, so the division is
// always evaluated).
const DEFAULT_WITHDRAW_FREQUENCY: u64 = 86400u64;

// Minimum auto-withdrawal frequency, in seconds.
const MIN_WITHDRAW_FREQUENCY: u64 = 2u64;

// Allowed discrepancy between a caller-provided `now` input and the block
// timestamp, in seconds.
const NOW_TOLERANCE: i64 = 2i64 * 60i64; // 2 mins
// The 'test_zebec_payroll_v4' program.

program test_zebec_payroll_v4.aleo {
    // Payroll configurations, keyed by unique config name (a BHP256 hash of
    // the off-chain name).
    mapping payroll_configs: field => PayrollConfig;
    // Fee tiers per config, keyed by BHP256 hash of `FeeTierKey`, looked up
    // by USD stream value.
    mapping fee_tiers: field => FeeTier;
    // Whitelisted streaming tokens per config, keyed by BHP256 hash of
    // `WhitelistKey` => allowed).
    mapping whitelisted_token_programs: field => bool;
    // Map of stream_id and stream anchor
    mapping stream_anchors: field => StreamAnchor;
    // Map of stream_id and payroll info
    mapping payrolls: field => Payroll;
    // Map of Token Price nonce => used;
    mapping token_price_nonces: field => bool;

    // Sender payroll ticket which can be used for operations like pause/resume/topup/cancel
    record SenderPayrollTicket {
        owner: address,
        ticket_type: u8, // = 0; means sender ticket
        // Config (tenant) the stream was created under.
        config: field,
        stream_id: field,
        receiver: address,
        token_program: identifier,
        full_amount: u128,
        is_cancelable: bool,
        is_pausable: bool,
        can_topup: bool,
        topup_count: u64,
    }

    // Receiver payroll ticket which can be used for operation like withdraw
    record ReceiverPayrollTicket {
        owner: address,
        ticket_type: u8, // = 1; receiver ticket
        // Config (tenant) the stream was created under.
        config: field,
        sender: address,
        token_program: identifier,
        full_amount: u128,
        auto_withdrawable: bool,
        stream_id: field,
    }

    // Withdrawer payroll tiket which can be used for operation like withdraw on behalf of receiver
    record WithdrawerPayrollTicket {
        owner: address,
        ticket_type: u8, // = 2; withdrawer ticket
        // Config (tenant) the stream was created under. Binds the ticket so
        // only that config's withdrawer can auto-withdraw the stream.
        config: field,
        full_amount: u128,
        stream_id: field,
        sender: address,
        receiver: address,
        token_program: identifier,
        auto_withdrawable: bool,
    }
    
    fn create_stream_private(
        params: CreateStreamParams,
        token_program: identifier,
        config: Config,
        token_price: TokenPrice,
        price_signature: signature,
        fee_bps: u64,
        credit_input_record: credits.aleo::credits,
        token_input_record: dyn record,
        sender_merkle_proofs: [MerkleProof; 2]
    ) -> (SenderPayrollTicket, ReceiverPayrollTicket, WithdrawerPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        assert(params.duration > 0u64);
        assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));
        
        let deposit_amount: u128 = params.can_topup ? params.initial_buffer_amount: params.amount;
        assert(deposit_amount > 0u128);
        let token_input_record_amount: u128 = token_input_record.amount as u128;
        assert(token_input_record_amount >= deposit_amount);

        let (usd_value, stream_fee) = compute_stream_fee(
            params.amount, 
            token_price.stream_token_price_usd, 
            token_price.aleo_price_usd, 
            fee_bps
        );

        let auto_withdrawal_fee: u64 = 0u64;
        // Leo flattens `if` branches: the division below executes even when
        // auto-withdrawal is disabled, so the divisor must be guarded.
        let safe_withdraw_frequency: u64 = params.withdraw_frequency > 0u64 ? params.withdraw_frequency : DEFAULT_WITHDRAW_FREQUENCY;
        if (params.auto_withdrawable) {
            assert(params.withdraw_frequency >= MIN_WITHDRAW_FREQUENCY); // minimum is per 2 seconds

            auto_withdrawal_fee = compute_auto_withdrawal_fee(
                params.duration, safe_withdraw_frequency, config.base_fee, config.platform_fee
            );
        }

        assert(credit_input_record.microcredits >= auto_withdrawal_fee + stream_fee);

        let (change1, change2): (credits.aleo::credits, credits.aleo::credits) = 
            credits.aleo::split(credit_input_record, auto_withdrawal_fee);

        let (auto_change, f_auto_withdrawal_fee_transfer): (credits.aleo::credits, Final) =
            credits.aleo::transfer_private_to_public(change1, config.withdrawer, auto_withdrawal_fee);
        
        let (fee_change, f_stream_fee_transfer): (credits.aleo::credits, Final) = 
            credits.aleo::transfer_private_to_public(change2, config.fee_vault, stream_fee);
        
        let (comp, change, f_deposit_amount_transfer): (dyn record, dyn record, Final) =
            IARC22@(token_program)::transfer_private_to_public(
                self_address, deposit_amount, token_input_record, sender_merkle_proofs
            );

        let sender_ticket = SenderPayrollTicket {
            owner: signer,
            ticket_type: 0u8,
            config: config.config_name,
            stream_id: params.stream_id,
            receiver: params.receiver,
            token_program: token_program,
            full_amount: params.amount,
            is_cancelable: params.is_cancelable,
            is_pausable: params.is_pausable,
            can_topup: params.can_topup,
            topup_count: params.can_topup ? 1u64 : 0u64, // initial buffer funding counts as topup
        };

        let receiver_ticket = ReceiverPayrollTicket {
            owner: params.receiver,
            ticket_type: 1u8,
            config: config.config_name,
            sender: signer,
            token_program: token_program,
            full_amount: params.amount,
            auto_withdrawable: params.auto_withdrawable,
            stream_id: params.stream_id,
        };

        let withdrawer_ticket = WithdrawerPayrollTicket {
            owner: config.withdrawer,
            ticket_type: 2u8,
            config: config.config_name,
            full_amount: params.amount,
            stream_id: params.stream_id,
            sender: signer,
            receiver: params.receiver,
            token_program: token_program,
            auto_withdrawable: params.auto_withdrawable,
        };

        return (sender_ticket, receiver_ticket, withdrawer_ticket, final {
            let now: i64 = std::ctx::block_timestamp(); 

            // Checks: stream parameter validation
            assert(params.duration > 0u64);
            assert(params.receiver != signer);
            assert(params.amount > 0u128);
            assert(params.start_now || params.start_time >= now);
            assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));

            // Checks: fee bps check
            assert(fee_bps <= BPS_DENOMINATOR);

            // Checks: config & fee re-verification
            let chain_config: PayrollConfig = payroll_configs.get(config.config_name);
            assert_config_fields(chain_config, config);

            // Checks: backend-signed token price
            // Verify nonce is not used. (Resolves replay attack)
            let used = token_price_nonces.get_or_use(token_price.nonce, false);
            assert(!used);
            // Consume the nonce so the signed price cannot be replayed.
            token_price_nonces.set(token_price.nonce, true);
            assert_token_price_binding(token_price, config, token_program, now);
            // Message the admin signed: token id || prices || expiry || nonce.
            let price_message: field = BHP256::hash_to_field(token_price);
            // Verified on-chain with a Schnorr signature against the config
            // admin's public key.
            let price_valid: bool =
                std::sig::verify_schnorr(price_signature, config.admin, price_message);
            assert(price_valid);

            // Checks: token whitelist (scoped to this config)
            let whitelist_key: field = BHP256::hash_to_field(
                WhitelistKey { config: config.config_name, token_program: token_program },
            );
            let allowed = whitelisted_token_programs.get_or_use(whitelist_key, false);
            assert(allowed);

            // Checks: fee tier for the stream's USD value
            let tier_found: bool = false;
            let tier_fee: u64 = 0u64;
            for i: u8 in 0u8..MAX_FEE_TIERS {
                let tier_key: field = BHP256::hash_to_field(
                    FeeTierKey { config: config.config_name, index: i },
                );
                let tier: FeeTier = fee_tiers.get_or_use(
                    tier_key,
                    FeeTier { min_amount: 0u64, max_amount: 0u64, fee_bps: 0u64 },
                );
                let matches: bool = !tier_found
                    && usd_value > tier.min_amount
                    && usd_value <= tier.max_amount;
                tier_found = tier_found || matches;
                tier_fee = matches ? tier.fee_bps : tier_fee;
            }
            assert(tier_found);
            assert(tier_fee == fee_bps);

            // Checks: stream id is fresh
            assert(!stream_anchors.contains(params.stream_id));

            let start_time: i64 = params.start_now ? now : params.start_time;
            let covered_until: i64 = compute_buffer_coverage(
                deposit_amount, params.duration, params.amount, start_time, params.can_topup
            );

            let stream_anchor = StreamAnchor {
                stream_id: params.stream_id,
                start_time: start_time,
                duration: params.duration,
                paused: false,
                canceled: false,
                canceled_at: 0i64,
                deposited_amount: deposit_amount,
                covered_until: covered_until,
                last_paused_time: 0i64,
                paused_interval: 0u64,
                withdrawn_amount: 0u128,
                is_public: false,
                created_timestamp: now,
                initialized: true,
            };

            stream_anchors.set(params.stream_id, stream_anchor);            

            f_auto_withdrawal_fee_transfer.run();
            f_stream_fee_transfer.run();
            f_deposit_amount_transfer.run();
        });
    }

    fn pause_resume_stream_private(
        ticket_record: SenderPayrollTicket,
    )-> (SenderPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        // Check signer is the sender payroll ticket owner
        assert(signer == ticket_record.owner);

        // Check if stream is pausable
        assert(ticket_record.is_pausable);
        let stream_id = ticket_record.stream_id;

        let sender_ticket = SenderPayrollTicket { ..ticket_record };
        return (sender_ticket, final {
            let now: i64 = std::ctx::block_timestamp();
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream is not canceled
            assert(!stream.canceled);
            // Check: Stream has started
            assert(stream.start_time <= now);

            let updated_stream = apply_pause_toggle(stream, now);
            stream_anchors.set(stream_id, updated_stream);
        });
    }

    fn cancel_stream_private(
        ticket_record: SenderPayrollTicket,
        stream_anchor: StreamAnchor,
        now: i64,
    )-> (SenderPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        let self_address:  address = std::ctx::addr();

        // Check: Signer is the sender payroll ticket owner
        assert(signer == ticket_record.owner);
        assert(ticket_record.is_cancelable);
        assert(stream_anchor.initialized);
        assert(stream_anchor.stream_id == ticket_record.stream_id);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Stream has not ended
        let prev_paused_interval: u64 = stream_anchor.paused_interval;
        let elapsed_duration: u64 = (effective_time as u64 - stream_anchor.start_time as u64) - prev_paused_interval;
        assert(elapsed_duration < stream_anchor.duration);
        
        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        // Cancel settles the whole stream, so full funding is required: on an
        // underfunded buffer stream the sender must clear the debt with a
        // top-up before cancelling.
        assert(total_withdrawable_amount <= stream_anchor.deposited_amount);

        let sender_amount: u128 = stream_anchor.deposited_amount - total_withdrawable_amount;

        let (comp_a, token_a, f_sender_amount_transfer) 
            = IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.owner, sender_amount
            );

        let (comp_b, token_b, f_receiver_amount_transfer) 
            = IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.receiver, currently_withdrawable_amount
            );
        
        let stream_id = ticket_record.stream_id;
        let sender_ticket = SenderPayrollTicket { ..ticket_record };
        
        return (sender_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, stream);

            let canceled_stream = StreamAnchor {
                ..stream
            };
            canceled_stream.canceled = true;
            canceled_stream.canceled_at = now;
            stream_anchors.set(stream_id, canceled_stream);

            f_sender_amount_transfer.run();
            f_receiver_amount_transfer.run();
        });
    }

    // Top up a buffer-mode private stream (debt model). Sender only: owning
    // the SenderPayrollTicket record is the authorization. Debt is measured
    // in stream time (pause-aware), mirroring the accrual logic:
    //   stream_time_now = effective_time - paused_interval
    //   debt = max(0, stream_time_now - covered_until) * full_amount / duration
    // The top-up pays the accrued debt plus an optional `extra` pre-payment;
    // `extra` buys extra * duration / full_amount additional covered seconds.
    fn topup_stream_private(
        ticket_record: SenderPayrollTicket,
        stream_anchor: StreamAnchor,
        extra: u128,
        now: i64,
        token_input_record: dyn record,
        sender_merkle_proofs: [MerkleProof; 2]
    ) -> (SenderPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        // Check: Signer is the sender payroll ticket owner
        assert(signer == ticket_record.owner);
        // Check: Stream was created with top-up enabled
        assert(ticket_record.can_topup);
        assert(stream_anchor.initialized);
        assert(stream_anchor.stream_id == ticket_record.stream_id);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        // Check: Buffer-mode streams have a non-zero covered_until
        assert(stream_anchor.covered_until > 0i64);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Stream has not ended
        let elapsed_duration: u64 = (effective_time as u64 - stream_anchor.start_time as u64) - stream_anchor.paused_interval;
        assert(elapsed_duration < stream_anchor.duration);

        // Debt in stream time: paused durations do not accrue debt.
        let stream_time_now: i64 = effective_time - stream_anchor.paused_interval as i64;
        let debt_seconds: i64 = stream_time_now > stream_anchor.covered_until ? stream_time_now - stream_anchor.covered_until : 0i64;
        let debt_amount: u128 = debt_seconds as u128 * ticket_record.full_amount / stream_anchor.duration as u128;

        let topup_amount: u128 = debt_amount + extra;
        assert(topup_amount > 0u128);

        // Extra covered seconds bought by the optional `extra` pre-payment.
        let extra_seconds_u128: u128 = extra * stream_anchor.duration as u128 / ticket_record.full_amount;
        assert(extra_seconds_u128 <= I64_MAX);
        let extra_seconds: i64 = extra_seconds_u128 as i64;

        let token_input_record_amount: u128 = token_input_record.amount as u128;
        assert(token_input_record_amount >= topup_amount);

        // Pull the top-up into the program's public balance (same pattern as
        // the create_stream_private deposit).
        let (comp, change, f_topup_transfer): (dyn record, dyn record, Final) =
            IARC22@(ticket_record.token_program)::transfer_private_to_public(
                self_address, topup_amount, token_input_record, sender_merkle_proofs
            );

        let stream_id = ticket_record.stream_id;
        let updated_ticket = SenderPayrollTicket { ..ticket_record };
        updated_ticket.topup_count = ticket_record.topup_count + 1u64;

        return (updated_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, stream);

            let updated_stream = StreamAnchor {
                ..stream
            };
            updated_stream.deposited_amount = stream.deposited_amount + topup_amount;
            // Advance covered_until monotonically: a debt-only topup
            // (extra == 0) must not erase forward coverage that was already
            // purchased in a prior topup.
            let coverage_base: i64 = stream.covered_until > stream_time_now ? stream.covered_until : stream_time_now;
            updated_stream.covered_until = coverage_base + extra_seconds;
            stream_anchors.set(stream_id, updated_stream);

            f_topup_transfer.run();
        });
    }

    fn withdraw_stream_private(
        ticket_record: ReceiverPayrollTicket,
        stream_anchor: StreamAnchor,
        now: i64,
    )-> (ReceiverPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        // Check: Signer is the receiver payroll ticket owner
        assert(signer == ticket_record.owner);
        // Check: Stream has started
        assert(stream_anchor.initialized);
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        // assert()

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Full amount is not withdrawn
        assert(stream_anchor.withdrawn_amount < ticket_record.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: the payout is capped at the funded remainder; amounts
        // accrued beyond the deposit stay locked until the next top-up.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;

        let (comp, token, f_receiver_amount_transfer) 
            = IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.owner, capped_withdrawable_amount
            );
        
        let stream_id = ticket_record.stream_id;
        let receiver_ticket = ReceiverPayrollTicket { ..ticket_record };
        
        return (receiver_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, stream);
        
            let withdrawn_amount: u128 = stream.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream = StreamAnchor {
                ..stream
            };
            updated_stream.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_id, updated_stream);

            f_receiver_amount_transfer.run();
        });
    }

    fn withdraw_stream_auto_private(
        ticket_record: WithdrawerPayrollTicket, 
        config: Config, 
        stream_anchor: StreamAnchor, 
        now: i64
    ) -> (WithdrawerPayrollTicket, Final) {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        // Check: Signer is the config withdrawer and owns the withdrawer ticket
        assert(signer == config.withdrawer);
        assert(signer == ticket_record.owner);
        // Check: The ticket belongs to this config (tenant binding)
        assert(ticket_record.config == config.config_name);
        // Check: Stream was created with auto-withdrawal enabled
        assert(ticket_record.auto_withdrawable);
        // Check: Stream has started
        assert(stream_anchor.initialized);
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        // assert()

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Full amount is not withdrawn
        assert(stream_anchor.withdrawn_amount < ticket_record.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: the payout is capped at the funded remainder; amounts
        // accrued beyond the deposit stay locked until the next top-up.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;
        // Check: There is something to pay out (skip dust/zero auto-withdrawals)
        assert(capped_withdrawable_amount > 0u128);

        let (comp, token, f_receiver_amount_transfer) 
            = IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.receiver, capped_withdrawable_amount
            );
        
        let stream_id = ticket_record.stream_id;
        let withdrawer_ticket = WithdrawerPayrollTicket { ..ticket_record };
        
        return (withdrawer_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);

            // Check: Validate the config exists
            assert(payroll_configs.contains(config.config_name));
            let chain_config = payroll_configs.get(config.config_name);
            // Check: Payroll config matches the provided config
            assert_config_fields(chain_config, config);

            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, stream);
        
            let withdrawn_amount: u128 = stream.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream = StreamAnchor {
                ..stream
            };
            updated_stream.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_id, updated_stream);

            f_receiver_amount_transfer.run();
        });
    }

    fn create_stream_public(
        params: CreateStreamParams,
        token_program: identifier,
        config: Config,
        token_price: TokenPrice,
        price_signature: signature,
        fee_bps: u64,
    ) -> Final {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        assert(params.duration > 0u64);
        assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));

        let deposit_amount: u128 = params.can_topup ? params.initial_buffer_amount: params.amount;
        assert(deposit_amount > 0u128);

        let (usd_value, stream_fee) = compute_stream_fee(
            params.amount, 
            token_price.stream_token_price_usd, 
            token_price.aleo_price_usd, 
            fee_bps
        );

        let auto_withdrawal_fee: u64 = 0u64;
        // Leo flattens `if` branches: the division below executes even when
        // auto-withdrawal is disabled, so the divisor must be guarded.
        let safe_withdraw_frequency: u64 = params.withdraw_frequency > 0u64 ? params.withdraw_frequency : DEFAULT_WITHDRAW_FREQUENCY;
        if (params.auto_withdrawable) {
            assert(params.withdraw_frequency >= MIN_WITHDRAW_FREQUENCY);

            auto_withdrawal_fee = compute_auto_withdrawal_fee(
                params.duration, safe_withdraw_frequency, config.base_fee, config.platform_fee
            );
        }

        // ALEO fees are paid from the signer's public credits balance.
        let f_stream_fee_transfer: Final =
            credits.aleo::transfer_public_as_signer(config.fee_vault, stream_fee);
        let f_auto_withdrawal_fee_transfer: Final =
            credits.aleo::transfer_public_as_signer(config.withdrawer, auto_withdrawal_fee);

        // Pull the token deposit into the program's public balance.
        // Prerequisite: the sender must have called `approve_public` on the
        // token program, approving this program for at least `deposit_amount`.
        let f_deposit_transfer: Final =
            IARC22@(token_program)::transfer_from_public(signer, self_address, deposit_amount);

        return final {
            let now: i64 = std::ctx::block_timestamp();

            // Checks: stream parameter validation
            assert(params.duration > 0u64);
            assert(params.receiver != signer);
            assert(params.amount > 0u128);
            assert(params.start_now || params.start_time >= now);
            assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));

            // Checks: fee bps check
            assert(fee_bps <= BPS_DENOMINATOR);

            // Checks: config & fee re-verification
            let chain_config: PayrollConfig = payroll_configs.get(config.config_name);
            assert_config_fields(chain_config, config);

            // Checks: backend-signed token price
            // Verify nonce is not used. (Resolves replay attack)
            let used = token_price_nonces.get_or_use(token_price.nonce, false);
            assert(!used);
            // Consume the nonce so the signed price cannot be replayed.
            token_price_nonces.set(token_price.nonce, true);
            assert_token_price_binding(token_price, config, token_program, now);
            // Message the admin signed: token id || prices || expiry || nonce.
            let price_message: field = BHP256::hash_to_field(token_price);
            // Verified on-chain with a Schnorr signature against the config
            // admin's public key.
            let price_valid: bool =
                std::sig::verify_schnorr(price_signature, config.admin, price_message);
            assert(price_valid);

            // Checks: token whitelist (scoped to this config)
            let whitelist_key: field = BHP256::hash_to_field(
                WhitelistKey { config: config.config_name, token_program: token_program },
            );
            let allowed = whitelisted_token_programs.get_or_use(whitelist_key, false);
            assert(allowed);

            // Checks: fee tier for the stream's USD value
            let tier_found: bool = false;
            let tier_fee: u64 = 0u64;
            for i: u8 in 0u8..MAX_FEE_TIERS {
                let tier_key: field = BHP256::hash_to_field(
                    FeeTierKey { config: config.config_name, index: i },
                );
                let tier: FeeTier = fee_tiers.get_or_use(
                    tier_key,
                    FeeTier { min_amount: 0u64, max_amount: 0u64, fee_bps: 0u64 },
                );
                let matches: bool = !tier_found
                    && usd_value > tier.min_amount
                    && usd_value <= tier.max_amount;
                tier_found = tier_found || matches;
                tier_fee = matches ? tier.fee_bps : tier_fee;
            }
            assert(tier_found);
            assert(tier_fee == fee_bps);

            // Checks: stream id is fresh
            assert(!stream_anchors.contains(params.stream_id));
            assert(!payrolls.contains(params.stream_id));

            let start_time: i64 = params.start_now ? now : params.start_time;
            let covered_until: i64 = compute_buffer_coverage(
                deposit_amount, params.duration, params.amount, start_time, params.can_topup
            );

            let stream_anchor = StreamAnchor {
                stream_id: params.stream_id,
                start_time: start_time,
                duration: params.duration,
                paused: false,
                canceled: false,
                canceled_at: 0i64,
                deposited_amount: deposit_amount,
                covered_until: covered_until,
                last_paused_time: 0i64,
                paused_interval: 0u64,
                withdrawn_amount: 0u128,
                is_public: true,
                created_timestamp: now,
                initialized: true,
            };
            stream_anchors.set(params.stream_id, stream_anchor);

            // Public mode stores the payroll metadata in a mapping instead of
            // issuing sender/receiver/withdrawer ticket records.
            let payroll = Payroll {
                stream_id: params.stream_id,
                config: config.config_name,
                sender: signer,
                receiver: params.receiver,
                full_amount: params.amount,
                token_program: token_program,
                is_cancelable: params.is_cancelable,
                is_pausable: params.is_pausable,
                can_topup: params.can_topup,
                topup_count: params.can_topup ? 1u64 : 0u64, // initial buffer funding counts as topup
                auto_withdrawable: params.auto_withdrawable,
                initialized: true
            };
            payrolls.set(params.stream_id, payroll);

            f_stream_fee_transfer.run();
            f_auto_withdrawal_fee_transfer.run();
            f_deposit_transfer.run();
        };
    }

    fn pause_resume_stream_public(
        stream_id: field,
    )-> Final {
        let signer: address = std::ctx::signer();
        
        return final {
            let now: i64 = std::ctx::block_timestamp();

            // Check: Validate payroll anchor exists
            assert(payrolls.contains(stream_id));
            let payroll = payrolls.get(stream_id);
            assert(signer == payroll.sender);
            assert(payroll.is_pausable);

            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));

            let anchor = stream_anchors.get(stream_id);
            // Check: Stream is not canceled
            assert(!anchor.canceled);
            assert(anchor.is_public);
            // Check: Stream has started
            assert(anchor.start_time <= now);

            let updated_anchor = apply_pause_toggle(anchor, now);
            stream_anchors.set(stream_id, updated_anchor);
        };
    }

    fn cancel_stream_public(
        payroll: Payroll,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> Final {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        // Check: Signer is the sender payroll ticket owner
        assert(signer == payroll.sender);
        assert(payroll.is_cancelable);
        assert(payroll.initialized);
        assert(stream_anchor.stream_id == payroll.stream_id);
        assert(stream_anchor.initialized);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);
        
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Stream has not ended
        let prev_paused_interval: u64 = stream_anchor.paused_interval;
        let elapsed_duration: u64 = (effective_time as u64 - stream_anchor.start_time as u64) - prev_paused_interval;
        assert(elapsed_duration < stream_anchor.duration);
        
        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            payroll.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= payroll.full_amount);
        // Cancel settles the whole stream, so full funding is required: on an
        // underfunded buffer stream the sender must clear the debt with a
        // top-up before cancelling.
        assert(total_withdrawable_amount <= stream_anchor.deposited_amount);

        let sender_amount: u128 = stream_anchor.deposited_amount - total_withdrawable_amount;

        let payroll_token_program = payroll.token_program;
        let f_sender_amount_transfer: Final 
            = IARC22@(payroll_token_program)::transfer_from_public(
                self_address, payroll.sender, sender_amount
            );

        let f_receiver_amount_transfer: Final 
            = IARC22@(payroll_token_program)::transfer_from_public(
                self_address, payroll.receiver, currently_withdrawable_amount
            );
        
        return final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);
            assert(stream_anchor.stream_id == payroll.stream_id);
            // Check: Validate the payroll exists
            assert(payrolls.contains(payroll.stream_id));
            let onchain_payroll = payrolls.get(payroll.stream_id);
            // Check On chain payroll matches the provided payroll
            assert_payroll_eq(payroll, onchain_payroll);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_anchor.stream_id));
            let onchain_anchor = stream_anchors.get(stream_anchor.stream_id);
            // Check: On chain stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, onchain_anchor);

            let canceled_stream = StreamAnchor {
                ..onchain_anchor
            };
            canceled_stream.canceled = true;
            canceled_stream.canceled_at = now;
            stream_anchors.set(stream_anchor.stream_id, canceled_stream);

            f_sender_amount_transfer.run();
            f_receiver_amount_transfer.run();
        };
    }

    fn withdraw_stream_public(
        payroll: Payroll,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> Final {
        let signer: address = std::ctx::signer();
        let self_address: address = std::ctx::addr();

        // Check: Signer is the receiver of payroll
        assert(signer == payroll.receiver);
        assert(payroll.stream_id == stream_anchor.stream_id);
        assert(payroll.initialized);
        // Check: Stream has started
        assert(stream_anchor.initialized);
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: Stream has started
        assert(stream_anchor.start_time <= effective_time);
        // Check: Full amount is not withdrawn
        assert(stream_anchor.withdrawn_amount < payroll.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            payroll.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= payroll.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: the payout is capped at the funded remainder; amounts
        // accrued beyond the deposit stay locked until the next top-up.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;

        let f_receiver_amount_transfer: Final 
            = IARC22@(payroll.token_program)::transfer_from_public(
                self_address, payroll.receiver, capped_withdrawable_amount
            );
        
        return final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert_within_tolerance(real_now, now);

            assert(payroll.stream_id == stream_anchor.stream_id);
            // Check: Validate the payroll exists
            assert(payrolls.contains(payroll.stream_id));
            let onchain_payroll = payrolls.get(payroll.stream_id);
            // Check On chain payroll matches the provided payroll
            assert_payroll_eq(payroll, onchain_payroll);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_anchor.stream_id));
            let onchain_anchor = stream_anchors.get(stream_anchor.stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert_stream_anchor_eq(stream_anchor, onchain_anchor);
        
            let withdrawn_amount: u128 = onchain_anchor.withdrawn_amount + capped_withdrawable_amount;
            let updated_anchor = StreamAnchor {
                ..onchain_anchor
            };
            updated_anchor.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_anchor.stream_id, updated_anchor);

            f_receiver_amount_transfer.run();
        };
    }

    view fn get_payroll(stream_id: field) -> Payroll {
        assert(payrolls.contains(stream_id));
        return payrolls.get(stream_id);
    }

    view fn get_stream_anchor(stream_id: field) -> StreamAnchor {
        assert(stream_anchors.contains(stream_id));
        return stream_anchors.get(stream_id);
    }

    // =========================================================================
    // Admin: configuration management
    // =========================================================================

    // One-time initialization of a payroll config under a unique
    // `config_name`. The caller becomes the config's admin.
    fn initialize_config(
        config_name: field,
        fee_vault: address,
        withdrawer: address,
        base_fee: u64,
        platform_fee: u64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        return final {
            // Config names are unique: initialization fails if one exists.
            assert(!payroll_configs.contains(config_name));
            payroll_configs.set(
                config_name,
                PayrollConfig {
                    admin: caller,
                    fee_vault: fee_vault,
                    withdrawer: withdrawer,
                    base_fee: base_fee,
                    platform_fee: platform_fee,
                    initialized: true,
                },
            );
        };
    }

    // Update fee/vault settings of a payroll config. Config admin only.
    fn update_config(
        config_name: field,
        fee_vault: address,
        withdrawer: address,
        base_fee: u64,
        platform_fee: u64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        return final {
            let config: PayrollConfig = payroll_configs.get(config_name);
            assert(config.admin == caller);
            assert(config.initialized);
            payroll_configs.set(
                config_name,
                PayrollConfig {
                    admin: config.admin,
                    fee_vault: fee_vault,
                    withdrawer: withdrawer,
                    base_fee: base_fee,
                    platform_fee: platform_fee,
                    initialized: true,
                },
            );
        };
    }

    // Set or replace a fee tier of a payroll config. Config admin only.
    fn set_fee_tier(
        config_name: field,
        index: u8,
        min_amount: u64,
        max_amount: u64,
        fee_bps: u64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        // Tiers must be well-formed: a non-empty range and a fee within 100%.
        assert(min_amount < max_amount);
        assert(fee_bps <= BPS_DENOMINATOR);
        let tier_key: field = BHP256::hash_to_field(
            FeeTierKey { config: config_name, index: index },
        );
        return final {
            let config: PayrollConfig = payroll_configs.get(config_name);
            assert(config.admin == caller);
            assert(index < MAX_FEE_TIERS);
            fee_tiers.set(
                tier_key,
                FeeTier {
                    min_amount: min_amount,
                    max_amount: max_amount,
                    fee_bps: fee_bps,
                },
            );
        };
    }

    // Whitelist or de-whitelist a streaming token for a payroll config.
    // Config admin only.
    fn set_token_whitelisted(
        config_name: field,
        token_program: identifier,
        allowed: bool,
    ) -> Final {
        let caller: address = std::ctx::caller();
        let whitelist_key: field = BHP256::hash_to_field(
            WhitelistKey { config: config_name, token_program: token_program },
        );

        return final {
            let config: PayrollConfig = payroll_configs.get(config_name);
            assert(config.admin == caller);
            whitelisted_token_programs.set(whitelist_key, allowed);
        };
    }

    view fn get_payroll_config(config_name: field) -> PayrollConfig {
        assert(payroll_configs.contains(config_name));
        return payroll_configs.get(config_name);
    }

    view fn get_fee_tier(config_name: field, index: u8) -> FeeTier {
        assert(index < MAX_FEE_TIERS);
        let tier_key: field = BHP256::hash_to_field(
            FeeTierKey { config: config_name, index: index },
        );
        assert(fee_tiers.contains(tier_key));
        return fee_tiers.get(tier_key);
    }

    view fn is_token_whitelisted(config_name: field, token_program: identifier) -> bool {
        let whitelist_key: field = BHP256::hash_to_field(
            WhitelistKey { config: config_name, token_program: token_program },
        );
        return whitelisted_token_programs.get_or_use(whitelist_key, false);
    }
    // This is the constructor for the program.
    // The constructor allows you to manage program upgrades.
    // It is called when the program is deployed or upgraded.
    // It is currently configured to **prevent** upgrades.
    // Other configurations include:
    //  - @admin(address="aleo1...")
    //  - @checksum(mapping="credits.aleo/fixme", key="0field")
    //  - @custom
    // For more information, please refer to the documentation: `https://docs.leo-lang.org/guides/upgradability`
    @admin(address="aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038")
    constructor() {}
}

// Compute the USD value of a stream amount and the stream fee in microcredits.
// Returns (usd_value, stream_fee).
fn compute_stream_fee(
    amount: u128,
    token_price_usd: u64,
    aleo_price_usd: u64,
    fee_bps: u64,
) -> (u64, u64) {
    // Widen to u128 for the intermediate products so large streams cannot
    // overflow, and assert the results fit in u64 instead of silently
    // truncating them with a down-cast.
    let usd_value: u128 = (amount * token_price_usd as u128) / USD_PRICE_DECIMALS_SCALE as u128;
    let fee_usd: u128 = (usd_value * fee_bps as u128) / BPS_DENOMINATOR as u128;
    let stream_fee: u128 = (fee_usd * USD_PRICE_DECIMALS_SCALE as u128) / aleo_price_usd as u128;
    assert(usd_value <= U64_MAX);
    assert(stream_fee <= U64_MAX);
    return (usd_value as u64, stream_fee as u64);
}

// Compute the total withdrawable and currently withdrawable amount for a stream
// Returns (total_withdrawable_amount, currently_withdrawable_amount)
fn compute_withdrawable_amount(
    effective_now: i64,
    start_time: i64,
    duration: u64,
    paused_interval: u64,
    full_stream_amount: u128, 
    withdrawn_amount: u128,
) -> (u128, u128) {
    assert(duration > 0u64);
    
    if (effective_now <= start_time) {
        return (0u128, 0u128);
    }
    
    // Here, we are sure if effective time <= start time, then the stream does not have paused interval. 
    // So, we can safely assume that paused_interval is 0 in this case.
    let elapsed_duration: u64 = (effective_now as u64 - start_time as u64) - paused_interval;
    
    if (elapsed_duration <= 0u64) {
        return (0u128, 0u128);
    }

    if (elapsed_duration >= duration) {
        return (full_stream_amount, full_stream_amount - withdrawn_amount);
    }

    let total_withdrawable_amount: u128 = elapsed_duration as u128 * full_stream_amount / duration as u128;
    assert(total_withdrawable_amount >= withdrawn_amount);
        
    return (total_withdrawable_amount, total_withdrawable_amount - withdrawn_amount);
}

// Assert every field of `provided` matches `onchain`. Used by cancel/topup/
// withdraw finals to confirm the caller-supplied anchor equals on-chain state.
fn assert_stream_anchor_eq(provided: StreamAnchor, onchain: StreamAnchor) {
    assert(onchain.stream_id == provided.stream_id);
    assert(onchain.start_time == provided.start_time);
    assert(onchain.duration == provided.duration);
    assert(onchain.paused == provided.paused);
    assert(onchain.canceled == provided.canceled);
    assert(onchain.canceled_at == provided.canceled_at);
    assert(onchain.deposited_amount == provided.deposited_amount);
    assert(onchain.covered_until == provided.covered_until);
    assert(onchain.last_paused_time == provided.last_paused_time);
    assert(onchain.paused_interval == provided.paused_interval);
    assert(onchain.withdrawn_amount == provided.withdrawn_amount);
    assert(onchain.is_public == provided.is_public);
    assert(onchain.created_timestamp == provided.created_timestamp);
    assert(onchain.initialized == provided.initialized);
}

// Assert every field of `provided` payroll matches `onchain`.
fn assert_payroll_eq(provided: Payroll, onchain: Payroll) {
    assert(onchain.stream_id == provided.stream_id);
    assert(onchain.config == provided.config);
    assert(onchain.sender == provided.sender);
    assert(onchain.receiver == provided.receiver);
    assert(onchain.full_amount == provided.full_amount);
    assert(onchain.token_program == provided.token_program);
    assert(onchain.is_cancelable == provided.is_cancelable);
    assert(onchain.is_pausable == provided.is_pausable);
    assert(onchain.can_topup == provided.can_topup);
    assert(onchain.auto_withdrawable == provided.auto_withdrawable);
    assert(onchain.topup_count == provided.topup_count);
}

// Assert the on-chain config matches the caller-provided config struct.
fn assert_config_fields(chain: PayrollConfig, provided: Config) {
    assert(chain.admin == provided.admin);
    assert(chain.fee_vault == provided.fee_vault);
    assert(chain.withdrawer == provided.withdrawer);
    assert(chain.base_fee == provided.base_fee);
    assert(chain.platform_fee == provided.platform_fee);
}

// Read-only binding/expiry checks for the admin-signed token price. The
// nonce-consume (token_price_nonces) and the Schnorr signature verification
// (a finalize-context intrinsic) must stay in the final block.
fn assert_token_price_binding(
    token_price: TokenPrice,
    config: Config,
    token_program: identifier,
    now: i64,
) {
    assert(now < token_price.price_expiry);
    assert(token_price.stream_token == token_program);
    assert(token_price.config == config.config_name);
}

// Assert the caller-supplied `now` is within NOW_TOLERANCE of the on-chain
// block timestamp.
fn assert_within_tolerance(real_now: i64, now: i64) {
    assert((real_now - now).abs() <= NOW_TOLERANCE);
}

// Apply a pause/resume toggle to `anchor` given the current `now`, returning
// the updated anchor. The caller performs the `stream_anchors.set`.
fn apply_pause_toggle(anchor: StreamAnchor, now: i64) -> StreamAnchor {
    let updated: StreamAnchor = StreamAnchor { ..anchor };
    if (anchor.paused) {
        assert(anchor.last_paused_time <= now);
        let paused_interval = anchor.paused_interval + (now as u64 - anchor.last_paused_time as u64);
        updated.paused_interval = paused_interval;
        updated.paused = false;
        updated.last_paused_time = 0i64;
    } else {
        let elapsed_duration: u64 = (now as u64 - anchor.start_time as u64) - anchor.paused_interval;
        assert(elapsed_duration < anchor.duration);
        updated.paused = true;
        updated.last_paused_time = now;
    }
    return updated;
}

// Compute the buffer-mode `covered_until` timestamp for a freshly created
// stream. `covered_until` is 0 when top-up mode is disabled.
fn compute_buffer_coverage(
    deposit_amount: u128,
    duration: u64,
    full_amount: u128,
    start_time: i64,
    can_topup: bool,
) -> i64 {
    let buffer_secs: u64 = ((deposit_amount * duration as u128) / full_amount) as u64;
    return can_topup ? start_time + buffer_secs as i64 : 0i64;
}

// Compute the auto-withdrawal fee in microcredits for a stream. The caller is
// responsible for asserting the withdraw frequency meets the minimum.
fn compute_auto_withdrawal_fee(
    duration: u64,
    safe_withdraw_frequency: u64,
    base_fee: u64,
    platform_fee: u64,
) -> u64 {
    let transaction_fee: u64 = (duration / safe_withdraw_frequency) * base_fee;
    return platform_fee + transaction_fee;
}