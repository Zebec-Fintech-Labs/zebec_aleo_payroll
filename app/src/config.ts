import { configNameToField } from "../../sdk/hashing.ts";

/** Stream program on testnet. */
export const PROGRAM_ID = "test_zebec_stream_v1.aleo";
/** Testnet explorer API host (mapping reads, tx confirmation fallback). */
export const HOST = "https://api.explorer.provable.com/v1";
/** Freeze list of the IARC22 token program (compliance proofs). */
export const FREEZE_LIST_URL =
  "https://api.explorer.provable.com/v2/testnet/programs/test_usdcx_freezelist.aleo/compliance/freeze-list";

/** On-chain config key, derived exactly as in scripts/stream.ts. */
export const CONFIG_NAME = configNameToField("Stream_Config_001");

/** Bare identifier of the stream token program (no `.aleo` suffix). */
export const TOKEN_PROGRAM = "test_usdcx_stablecoin";
export const TOKEN_PROGRAM_ID = `${TOKEN_PROGRAM}.aleo`;
export const CREDITS_PROGRAM_ID = "credits.aleo";

/**
 * Programs the wallet must load as external stacks for the stream program's
 * `call.dynamic` token transfers. The stream program only *statically* imports
 * credits.aleo, so the token program and its transitive imports are invisible to
 * the wallet's process builder unless declared here. Without them the dynamic
 * dispatch fails with "External stack for 'test_usdcx_stablecoin.aleo' does not
 * exist". Order is leaves-first (dependencies before dependents).
 */
export const DYNAMIC_DISPATCH_IMPORTS = [
  "merkle_tree.aleo",
  "test_usdcx_multisig_core.aleo",
  "test_usdcx_freezelist.aleo",
  TOKEN_PROGRAM_ID,
];

/**
 * Stream fee charged per create transaction, in microcredits. Embedded in the
 * admin-signed `StreamTokenFee` attestation (the on-chain program verifies the
 * signature and consumes the nonce; it has no USD price logic).
 */
export const STREAM_FEE_AMOUNT = 100_000n;

/** Default transaction fee in microcredits (0.1 ALEO). */
export const DEFAULT_FEE = 100_000;
