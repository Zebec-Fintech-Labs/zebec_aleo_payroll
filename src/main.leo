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
    start_time: i64,
    duration: u64,
    paused: bool,
    cancelled: bool,
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

// The 'aacs_payroll' program.
program aacs_payroll.aleo {
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
        stream_id: field,
        receiver: address,
        token_program: identifier,
        full_amount: u128,
        is_cancelable: bool,
        is_pausable: bool,
        can_topup: bool,
        topup_count: u64,
    }

    // Receiver payroll ticker which can be used for operation like withdraw
    record ReceiverPayrollTicket {
        owner: address,
        sender: address,
        token_program: identifier,
        full_amount: u128,
        stream_id: field,
    }

    record WithdrawerPayrollTicket {
        owner: address,
        full_amount: u128,
        stream_id: field,
        sender: address,
        receiver: address,
        token_program: identifier,
    }

    // record PayrollStream {
    //     owner: address,
    //     sender: address,
    //     receiver: address,
    //     stream_id: field,
    //     stream_token: field,
    //     cliff_percentage: u128,
    //     full_amount: u128,
    //     deposited_amount: u128,
    //     start_time: i64,
    //     end_time: i64,
    //     last_withdrawn_timestamp: i64,
    //     withdrawn_amount: u128,
    //     stream_duration: u128,
    //     is_pausable: bool,
    //     paused_timestamp: i64,
    //     paused_interval: i64,
    //     canceled_timestamp: i64,
    //     cancelable_by_sender: bool,
    //     cancelable_by_recipient: bool,
    //     autowithdraw_frequency: u128,
    //     auto_withdrawable: bool,
    //     can_topup: bool,
    //     topup_count: u128,
    //     covered_until: i64,
    // }



    fn create_stream_private(
        params: CreateStreamParams,
        config: Config,
        token_price: TokenPrice,
        price_signature: signature,
        fee_bps: u64,
        token_program: identifier,
        credit_input_record: credits.aleo::credits,
        token_input_record: dyn record,
        sender_merkle_proofs: [iarc22::MerkleProof; 2]
    ) -> Final {
        let signer: address = std::ctx::signer();

        assert(params.duration > 0u64);
        assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));
        
        let deposit_amount: u128 = params.can_topup ? params.initial_buffer_amount: params.amount;
        
        let (usd_value, stream_fee) = compute_stream_fee(
            params.amount, 
            token_price.stream_token_price_usd, 
            token_price.aleo_price_usd, 
            fee_bps
        );

        let auto_withdrawal_fee: u64 = 0u64;
        if (params.auto_withdrawable) {
            assert(params.withdraw_frequency > 0u64);

            let transaction_fee = (params.duration / params.withdraw_frequency) * config.base_fee;
            auto_withdrawal_fee = config.platform_fee + transaction_fee;
        }

        assert(auto_withdrawal_fee + stream_fee >= credit_input_record.microcredits);

        let (change1, change2): (credits.aleo::credits, credits.aleo::credits) = credits.aleo::split(credit_input_record, auto_withdrawal_fee);

        let (auto_change, f_auto_withdrawal_fee_transfer): (credits.aleo::credits, Final) =
            credits.aleo::transfer_private_to_public(change1, config.withdrawer, auto_withdrawal_fee);
        
        let (fee_change, f_stream_fee_transfer): (credits.aleo::credits, Final) = 
            credits.aleo::transfer_private_to_public(change2, config.fee_vault, stream_fee);
        
        let (comp, change, f_deposit_amount_transfer): (dyn record, dyn record, Final) =
            iarc22::IARC22@(token_program)::transfer_private_to_public(
                self.address, deposit_amount, token_input_record, sender_merkle_proofs
            );

        let sender_ticket = SenderPayrollTicket {
            owner: signer,
            stream_id: params.stream_id,
            receiver: params.receiver,
            token_program: token_program,
            full_amount: params.amount,
            is_cancelable: params.is_cancelable,
            is_pausable: params.is_pausable,
            can_topup: params.can_topup,
            topup_count: 1u64,
        };

        let receiver_ticket = ReceiverPayrollTicket {
            owner: params.receiver,
            sender: signer,
            token_program: token_program,
            full_amount: params.amount,
            stream_id: params.stream_id,
        };

        let withdrawer = WithdrawerPayrollTicket {
            owner: config.withdrawer,
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
            // Verified on-chain with a Schnorr signature against the config
            // admin's public key.
            assert(now < token_price.price_expiry);
            // Message the admin signed: token id || price || expiry.
            let price_message: field = BHP256::hash_to_field(token_price);
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
                start_time: start_time,
                duration: params.duration,
                paused: false,
                cancelled: false,
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
        token: identifier,
        allowed: bool,
    ) -> Final {
        let caller: address = std::ctx::caller();
        let whitelist_key: field = BHP256::hash_to_field(
            WhitelistKey { config: config_name, token_program: token },
        );

        return final {
            let config: PayrollConfig = payroll_config.get(config_name);
            assert(config.admin == caller);
            whitelisted_token_programs.set(whitelist_key, allowed);
        };
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
    @noupgrade
    constructor() {}
}

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