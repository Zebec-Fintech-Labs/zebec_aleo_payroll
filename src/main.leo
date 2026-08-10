import credits.aleo;

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
// `payroll_config` mapping, each under a unique config name. Fee tiers and
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
    auto_withdrawable: bool,
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

// The 'test_zebec_payroll' program.
program test_zebec_payroll.aleo {
    // Payroll configurations, keyed by unique config name (a BHP256 hash of
    // the off-chain name).
    mapping payroll_config: field => PayrollConfig;
    // Fee tiers per config, keyed by BHP256 hash of `FeeTierKey`, looked up
    // by USD stream value.
    mapping fee_tiers: field => FeeTier;
    // Whitelisted streaming tokens per config, keyed by BHP256 hash of
    // `WhitelistKey` => allowed).
    mapping whitelisted_token_programs: field => bool;
    // Map of stream_id and stream anchor
    mapping stream_anchors: field => StreamAnchor;
    // Map of Token Price nonce => used;
    mapping token_price_nonces: field => bool;

    // Sender payroll ticket which can be used for operations like pause/resume/topup/cancel
    record SenderPayrollTicket {
        owner: address,
        ticket_type: u8, // = 0; means sender ticket
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
        sender: address,
        token_program: identifier,
        full_amount: u128,
        stream_id: field,
    }

    // Withdrawer payroll tiket which can be used for operation like withdraw on behalf of receiver
    record WithdrawerPayrollTicket {
        owner: address,
        ticket_type: u8, // = 2; withdrawer ticket
        full_amount: u128,
        stream_id: field,
        sender: address,
        receiver: address,
        token_program: identifier,
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
        sender_merkle_proofs: [iarc22::MerkleProof; 2]
    ) -> Final {
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
        let safe_withdraw_frequency: u64 = params.withdraw_frequency > 0u64 ? params.withdraw_frequency : 1u64;
        if (params.auto_withdrawable) {
            assert(params.withdraw_frequency > 0u64);

            let transaction_fee = (params.duration / safe_withdraw_frequency) * config.base_fee;
            auto_withdrawal_fee = config.platform_fee + transaction_fee;
        }

        assert(credit_input_record.microcredits >= auto_withdrawal_fee + stream_fee);

        let (change1, change2): (credits.aleo::credits, credits.aleo::credits) = 
            credits.aleo::split(credit_input_record, auto_withdrawal_fee);

        let (auto_change, f_auto_withdrawal_fee_transfer): (credits.aleo::credits, Final) =
            credits.aleo::transfer_private_to_public(change1, config.withdrawer, auto_withdrawal_fee);
        
        let (fee_change, f_stream_fee_transfer): (credits.aleo::credits, Final) = 
            credits.aleo::transfer_private_to_public(change2, config.fee_vault, stream_fee);
        
        let (comp, change, f_deposit_amount_transfer): (dyn record, dyn record, Final) =
            iarc22::IARC22@(token_program)::transfer_private_to_public(
                self_address, deposit_amount, token_input_record, sender_merkle_proofs
            );

        let sender_ticket = SenderPayrollTicket {
            owner: signer,
            ticket_type: 0u8,
            stream_id: params.stream_id,
            receiver: params.receiver,
            token_program: token_program,
            full_amount: params.amount,
            is_cancelable: params.is_cancelable,
            is_pausable: params.is_pausable,
            can_topup: params.can_topup,
            topup_count: 1u64, // initial funding counts as topup
        };

        let receiver_ticket = ReceiverPayrollTicket {
            owner: params.receiver,
            ticket_type: 1u8,
            sender: signer,
            token_program: token_program,
            full_amount: params.amount,
            stream_id: params.stream_id,
        };

        let withdrawer = WithdrawerPayrollTicket {
            owner: config.withdrawer,
            ticket_type: 2u8,
            full_amount: params.amount,
            stream_id: params.stream_id,
            sender: signer,
            receiver: params.receiver,
            token_program: token_program,
        };

        return final {
            let now: i64 = std::ctx::block_timestamp(); 

            // Checks: stream parameter validation
            assert(params.duration > 0u64);
            assert(params.receiver != signer);
            assert(params.amount > 0u128);
            assert(!params.start_now || params.start_time >= now);
            assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));

            // Checks: fee bps check
            assert(fee_bps <= BPS_DENOMINATOR);

            // Checks: config & fee re-verification
            let chain_config: PayrollConfig = payroll_config.get(config.config_name);
            assert(chain_config.fee_vault == config.fee_vault);
            assert(chain_config.withdrawer == config.withdrawer);
            assert(chain_config.base_fee == config.base_fee);
            assert(chain_config.platform_fee == config.platform_fee);

            // Checks: backend-signed token price
            // Verify token price has not expired.
            assert(now < token_price.price_expiry);
            // Verify nonce is not used. (Resolves replay attack)
            let used = token_price_nonces.get_or_use(token_price.nonce, false);
            assert(!used);
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
            let buffer_secs: u64 = ((deposit_amount * params.duration as u128) / params.amount) as u64;
            let covered_until: i64 = params.can_topup ? start_time + buffer_secs as i64 : 0i64;
            
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
                auto_withdrawable: params.auto_withdrawable,
                withdrawn_amount: 0u128,
                is_public: false,
                created_timestamp: now,
                initialized: true,
            };

            stream_anchors.set(params.stream_id, stream_anchor);            

            f_auto_withdrawal_fee_transfer.run();
            f_stream_fee_transfer.run();
            f_deposit_amount_transfer.run();
        };
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

            if (stream.paused) {
                // |--------------|-----|--------------|-------------|
                // st               ppi                lpt         now
                let prev_paused_interval: u64 = stream.paused_interval; // may be 0 or value.
                assert(stream.last_paused_time <= now);
                let paused_interval = prev_paused_interval + (now as u64 - stream.last_paused_time as u64);
                let resumed_stream = StreamAnchor {
                    ..stream
                };
                resumed_stream.paused_interval = paused_interval;
                resumed_stream.paused  = false;
                resumed_stream.last_paused_time = 0i64;
                stream_anchors.set(stream_id, resumed_stream);
            } else {
                let prev_paused_interval: u64 = stream.paused_interval;
                let elapsed_duration: u64 = (now as u64 - stream.start_time as u64) - prev_paused_interval;
                // Check: Stream has not ended
                assert(elapsed_duration < stream.duration);
                let paused_stream = StreamAnchor {
                    ..stream
                };
                paused_stream.paused = true;
                paused_stream.last_paused_time = now;
                stream_anchors.set(stream_id, paused_stream); 
            }
        });
    }

    fn cancel_private(
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
        assert(total_withdrawable_amount <= stream_anchor.deposited_amount);

        let sender_amount: u128 = stream_anchor.deposited_amount - total_withdrawable_amount;

        let (comp_a, token_a, f_sender_amount_transfer) 
            = iarc22::IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.owner, sender_amount
            );

        let (comp_b, token_b, f_receiver_amount_transfer) 
            = iarc22::IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.receiver, currently_withdrawable_amount
            );
        
        let stream_id = ticket_record.stream_id;
        let sender_ticket = SenderPayrollTicket { ..ticket_record };
        
        return (sender_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert((real_now - now).abs() <= 5i64);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert(stream.stream_id == stream_id);
            assert(stream.stream_id == stream_anchor.stream_id);
            assert(stream.start_time == stream_anchor.start_time);
            assert(stream.duration == stream_anchor.duration);
            assert(stream.paused == stream_anchor.paused);
            assert(stream.canceled == stream_anchor.canceled);
            assert(stream.deposited_amount == stream_anchor.deposited_amount);
            assert(stream.covered_until == stream_anchor.covered_until);
            assert(stream.last_paused_time == stream_anchor.last_paused_time);
            assert(stream.paused_interval == stream_anchor.paused_interval);
            assert(stream.auto_withdrawable == stream_anchor.auto_withdrawable);
            assert(stream.withdrawn_amount == stream_anchor.withdrawn_amount);
            assert(stream.is_public == stream_anchor.is_public);
            assert(stream.created_timestamp == stream_anchor.created_timestamp);
            assert(stream.initialized == stream_anchor.initialized);

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

    fn withdraw_private(
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
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;
        assert(total_withdrawable_amount <= stream_anchor.deposited_amount);

        let (comp, token, f_receiver_amount_transfer) 
            = iarc22::IARC22@(ticket_record.token_program)::transfer_from_public_to_private(
                self_address, ticket_record.owner, capped_withdrawable_amount
            );
        
        let stream_id = ticket_record.stream_id;
        let receiver_ticket = ReceiverPayrollTicket { ..ticket_record };
        
        return (receiver_ticket, final {
            let real_now = std::ctx::block_timestamp();
            // Check: Validate now time discrepancy is within 5 seconds
            assert((real_now - now).abs() <= 5i64);
            // Check: Validate the streams exists
            assert(stream_anchors.contains(stream_id));
            let stream = stream_anchors.get(stream_id);
            // Check: Stream anchor matches the provided stream anchor
            assert(stream.stream_id == stream_id);
            assert(stream.stream_id == stream_anchor.stream_id);
            assert(stream.start_time == stream_anchor.start_time);
            assert(stream.duration == stream_anchor.duration);
            assert(stream.paused == stream_anchor.paused);
            assert(stream.canceled == stream_anchor.canceled);
            assert(stream.deposited_amount == stream_anchor.deposited_amount);
            assert(stream.covered_until == stream_anchor.covered_until);
            assert(stream.last_paused_time == stream_anchor.last_paused_time);
            assert(stream.paused_interval == stream_anchor.paused_interval);
            assert(stream.auto_withdrawable == stream_anchor.auto_withdrawable);
            assert(stream.withdrawn_amount == stream_anchor.withdrawn_amount);
            assert(stream.is_public == stream_anchor.is_public);
            assert(stream.created_timestamp == stream_anchor.created_timestamp);
            assert(stream.initialized == stream_anchor.initialized);
        
            let withdrawn_amount: u128 = stream.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream = StreamAnchor {
                ..stream
            };
            updated_stream.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_id, updated_stream);

            f_receiver_amount_transfer.run();
        });
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
            assert(!payroll_config.contains(config_name));
            payroll_config.set(
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
            let config: PayrollConfig = payroll_config.get(config_name);
            assert(config.admin == caller);
            assert(config.initialized);
            payroll_config.set(
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
        let tier_key: field = BHP256::hash_to_field(
            FeeTierKey { config: config_name, index: index },
        );
        return final {
            let config: PayrollConfig = payroll_config.get(config_name);
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
            let config: PayrollConfig = payroll_config.get(config_name);
            assert(config.admin == caller);
            whitelisted_token_programs.set(whitelist_key, allowed);
        };
    }

    view fn get_payroll_config(config_name: field) -> PayrollConfig {
        assert(payroll_config.contains(config_name));
        return payroll_config.get(config_name);
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
    let usd_value: u64 = ((amount * token_price_usd as u128) / USD_PRICE_DECIMALS_SCALE as u128) as u64;
    let fee_usd: u64 = (usd_value * fee_bps) / BPS_DENOMINATOR;
    let stream_fee: u64 = ((fee_usd as u128 * USD_PRICE_DECIMALS_SCALE as u128) / aleo_price_usd as u128) as u64;
    return (usd_value, stream_fee);
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