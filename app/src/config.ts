import { configNameToField } from "../../sdk/hashing.ts";

/** Payroll program on testnet. */
export const PROGRAM_ID = "test_zebec_payroll_v3.aleo";
/** Testnet explorer API host (mapping reads, tx confirmation fallback). */
export const HOST = "https://api.explorer.provable.com/v1";
/** Freeze list of the IARC22 token program (compliance proofs). */
export const FREEZE_LIST_URL =
  "https://api.explorer.provable.com/v2/testnet/programs/test_usdcx_freezelist.aleo/compliance/freeze-list";

/** On-chain config key, derived exactly as in scripts/payroll.ts. */
export const CONFIG_NAME = configNameToField("Payroll_Config_002");

/** Bare identifier of the stream token program (no `.aleo` suffix). */
export const TOKEN_PROGRAM = "test_usdcx_stablecoin";
export const TOKEN_PROGRAM_ID = `${TOKEN_PROGRAM}.aleo`;
export const CREDITS_PROGRAM_ID = "credits.aleo";

/** Fixed price attestation values (USD, 6 decimals), as in scripts/payroll.ts. */
export const TOKEN_PRICE_USD = 1_000_000n; // $1.00
export const ALEO_PRICE_USD = 200_000n; // $0.20

/** Default transaction fee in microcredits (0.1 ALEO). */
export const DEFAULT_FEE = 100_000;
