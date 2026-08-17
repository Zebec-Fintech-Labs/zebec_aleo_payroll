/**
 * Payroll stream lifecycle script: create -> pause -> resume -> withdraw ->
 * cancel, against the `test_zebec_payroll_v4.aleo` program on testnet.
 *
 * Prerequisites:
 * - Config `Payroll_Config_001` initialized (run `npm run admin` first) and
 *   `test_usdcx_stablecoin` whitelisted.
 * - The employer account (`PRIVATE_KEY`) must hold unspent
 *   `test_usdcx_stablecoin.aleo` Token records covering the stream deposit and
 *   credits.aleo records covering fees.
 * - The employee account (`RECEIVER_PRIVATE_KEY`) needs a small public credits
 *   balance for the withdraw priority fee. It must differ from the employer
 *   (the contract asserts `receiver != signer`).
 *
 * Environment variables:
 * - PRIVATE_KEY (required): employer/sender; also the config admin, so it
 *   signs the token price attestation.
 * - RECEIVER_PRIVATE_KEY (required): employee who withdraws.
 */

import { Address, Field, initThreadPool, RecordPlaintext, SealanceMerkleTree } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
    Arc22Service,
    computeStreamFee,
    configNameToField,
    DEFAULT_FEE_BPS,
    nowSeconds,
    PayrollClient,
    PROGRAM_ID,
    signTokenPrice,
    type Config,
    type CreateStreamParams,
    type MerkleProof,
    type TokenPrice,
} from "../sdk/index.js";

dotenv.config();

await initThreadPool();

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const SENDER_PRIVATE_KEY = process.env.SENDER_PRIVATE_KEY;
const RECEIVER_PRIVATE_KEY = process.env.RECEIVER_PRIVATE_KEY;

if (!ADMIN_PRIVATE_KEY) {
    console.error("ADMIN_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

if (!SENDER_PRIVATE_KEY) {
    console.error("SENDER_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

if (!RECEIVER_PRIVATE_KEY) {
    console.error("RECEIVER_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
// Checked above; bind so closures (e.g. createSignedTokenPrice) see `string`.
const HOST = process.env.ENDPOINT ?? "https://api.explorer.provable.com/v1";
console.log("HOST:", HOST);
const FREEZE_LIST_URL =
    "https://api.explorer.provable.com/v2/testnet/programs/test_usdcx_freezelist.aleo/compliance/freeze-list";

const here = path.dirname(fileURLToPath(import.meta.url));
// console.log("Current directory:", here);
const PROGRAM_SOURCE = fs.readFileSync(
    path.resolve(here, "../build/test_zebec_payroll_v4/test_zebec_payroll_v4.aleo"),
    "utf8",
);

const PROVER_URI = process.env.PROVER_URI || undefined;
const PROVER_API_KEY = process.env.PROVER_API_KEY || undefined;
const PROVER_CONSUMER_ID = process.env.PROVER_CONSUMER_ID || undefined;
if (PROVER_URI) {
    console.log("Using delegated proving service:", PROVER_URI);
}

const senderClient = new PayrollClient({
    host: HOST,
    privateKey: SENDER_PRIVATE_KEY,
    programSource: PROGRAM_SOURCE,
    proverUri: PROVER_URI,
    proverApiKey: PROVER_API_KEY,
    proverConsumerId: PROVER_CONSUMER_ID,
});
const receiverClient = new PayrollClient({
    host: HOST,
    privateKey: RECEIVER_PRIVATE_KEY,
    programSource: PROGRAM_SOURCE,
    proverUri: PROVER_URI,
    proverApiKey: PROVER_API_KEY,
    proverConsumerId: PROVER_CONSUMER_ID,
});
const sender = senderClient.account!.address().to_string();
const receiver = receiverClient.account!.address().to_string();
console.log("Sender (employer) address:", sender);
console.log("Receiver (employee) address:", receiver);

if (sender === receiver) {
    console.error("PRIVATE_KEY and RECEIVER_PRIVATE_KEY must be different accounts.");
    process.exit(1);
}

const CONFIG_NAME = configNameToField("Payroll_Config_002");
const TOKEN_PROGRAM = "test_usdcx_stablecoin";
const TOKEN_PRICE_USD = 1_000_000n; // $1.00, 6 decimals
const ALEO_PRICE_USD = 200_000n; // $0.20, 6 decimals

const STREAM_PARAMS: CreateStreamParams = {
    receiver,
    streamId: randomField(),
    amount: 2_000_000n,
    startTime: 0n, // ignored: startNow is true
    duration: 10n * 60n, // 10 minutes
    isCancelable: true,
    isPausable: true,
    autoWithdrawable: false,
    withdrawFrequency: 0n,
    startNow: true,
    canTopup: false,
    initialBufferAmount: 0n,
};

/** Random 128-bit field value (stream ids). */
export function randomField(): bigint {
    const bytes = Field.random().toBytesLe();
    return BigInt(
        "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    );
}

async function waitForConfirmation(txId: string) {
    const confirmation = await senderClient.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000);
    const confirmationStatus = confirmation.status;
    if (confirmationStatus.toLowerCase() !== "accepted") {
        throw new Error(`Transaction ${txId} failed with status: ${confirmationStatus}`);
    }
}

/** Read the on-chain payroll config and shape it as the `Config` input. */
async function getConfigInput(): Promise<Config> {
    const chainConfig = await senderClient.getPayrollConfig(CONFIG_NAME);
    return {
        configName: CONFIG_NAME,
        admin: chainConfig.admin,
        feeVault: chainConfig.feeVault,
        withdrawer: chainConfig.withdrawer,
        baseFee: chainConfig.baseFee,
        platformFee: chainConfig.platformFee,
    };
}

/**
 * Resolve the stream fee basis points. The on-chain program no longer has
 * per-config fee tiers, so a single flat `DEFAULT_FEE_BPS` is used for the
 * admin-signed stream fee (the `usdValue` argument is accepted for API
 * compatibility and ignored).
 */
async function resolveFeeBps(_usdValue: bigint): Promise<bigint> {
    return DEFAULT_FEE_BPS;
}

/** Build a fresh admin-signed `TokenPrice` attestation. */
function createSignedTokenPrice(): { tokenPrice: TokenPrice; signature: string } {
    const tokenPrice: TokenPrice = {
        config: CONFIG_NAME,
        streamToken: TOKEN_PROGRAM,
        streamTokenPriceUsd: TOKEN_PRICE_USD,
        aleoPriceUsd: ALEO_PRICE_USD,
        priceExpiry: nowSeconds() + 3600n,
        nonce: randomField(),
    };
    return { tokenPrice, signature: signTokenPrice(ADMIN_PRIVATE_KEY!, tokenPrice) };
}

/**
 * Build a Sealance Merkle exclusion proof showing the sender is NOT on the
 * token program's freeze list (required by IARC22 compliant transfers).
 */
async function getComplianceProofs(senderAddress: string): Promise<[MerkleProof, MerkleProof]> {
    const res = await fetch(FREEZE_LIST_URL);
    if (!res.ok) {
        throw new Error(`failed to fetch freeze list: ${res.status} ${res.statusText}`);
    }
    const sealance = new SealanceMerkleTree();
    const tree = sealance.convertTreeToBigInt(await res.json());
    const [leftIdx, rightIdx] = sealance.getLeafIndices(tree, senderAddress);
    const leftProof = sealance.getSiblingPath(tree, leftIdx, 16);
    const rightProof = sealance.getSiblingPath(tree, rightIdx, 16);
    return [
        { siblings: leftProof.siblings, leafIndex: leftProof.leaf_index },
        { siblings: rightProof.siblings, leafIndex: rightProof.leaf_index },
    ];
}

async function createStreamPrivate(): Promise<string | bigint> {
    const params = STREAM_PARAMS;
    console.log("streamId:", params.streamId);
    const config = await getConfigInput();
    const { tokenPrice, signature } = createSignedTokenPrice();
    // usdValue does not depend on feeBps; resolve the tier from it, then fee.
    const { usdValue } = computeStreamFee(
        params.amount,
        tokenPrice.streamTokenPriceUsd,
        tokenPrice.aleoPriceUsd,
        0n,
    );
    const feeBps = await resolveFeeBps(usdValue);
    const { streamFee } = computeStreamFee(
        params.amount,
        tokenPrice.streamTokenPriceUsd,
        tokenPrice.aleoPriceUsd,
        feeBps,
    );
    console.log(`Stream USD value: ${usdValue}, fee tier: ${feeBps} bps, stream fee: ${streamFee} microcredits`);
    const proofs = await getComplianceProofs(sender);

    const txId = await senderClient.createStreamPrivate(
        params,
        TOKEN_PROGRAM,
        config,
        tokenPrice,
        signature,
        feeBps,
        proofs,
        {
            priorityFee: 0.1,
            creditRecord: "{ owner: aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038.private, microcredits: 10000000u64.private, _nonce: 6410260858307819024593913311999508957203522779225348165403325458147180369361group.public, _version: 1u8.public }",
            tokenRecord: "{ owner: aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038.private, amount: 40000000u128.private, _nonce: 5129322304556379667216924448175967718654626044730865730388167874744975697882group.public, _version: 1u8.public }"
        },
    );
    console.log("Create stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(params.streamId);
    console.log("Created stream anchor:", anchor);
    return params.streamId;
}

async function createStreamPublic(): Promise<string | bigint> {
    const params = STREAM_PARAMS;
    console.log("streamId:", params.streamId);
    const config = await getConfigInput();
    const { tokenPrice, signature } = createSignedTokenPrice();
    const { usdValue } = computeStreamFee(
        params.amount,
        tokenPrice.streamTokenPriceUsd,
        tokenPrice.aleoPriceUsd,
        0n,
    );
    const feeBps = await resolveFeeBps(usdValue);
    // `create_stream_public` pulls the deposit via `transfer_from_public`,
    // which requires this payroll program to be approved as the spender first.
    // Check the on-chain allowance and approve if it is too low.
    const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
    const programAddress = Address.fromProgramId(PROGRAM_ID).toString();
    const tokenService = new Arc22Service({
        tokenProgram: TOKEN_PROGRAM,
        privateKey: SENDER_PRIVATE_KEY,
        host: HOST,
        proverUri: PROVER_URI,
        proverApiKey: PROVER_API_KEY,
        proverConsumerId: PROVER_CONSUMER_ID,
    });
    const allowance = await tokenService.getAllowance(sender, programAddress);
    if (allowance < depositAmount) {
        console.log(
            `Allowance ${allowance} < deposit ${depositAmount}; approving ${PROGRAM_ID} for ${depositAmount}...`,
        );
        const approveTxId = await tokenService.approve(programAddress, depositAmount, { priorityFee: 0.1 });
        await waitForConfirmation(approveTxId);
        console.log("Approved payroll program to spend tokens:", approveTxId);
    } else {
        console.log(`Allowance ${allowance} already covers deposit ${depositAmount}; no approval needed.`);
    }
    // The employer must hold enough public credits for the fees. No records/proofs needed.
    const txId = await senderClient.createStreamPublic(
        params,
        TOKEN_PROGRAM,
        config,
        tokenPrice,
        signature,
        feeBps,
        { priorityFee: 0.1 },
    );
    console.log("Create public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(params.streamId);
    const payroll = await senderClient.getPayroll(params.streamId);
    console.log("Created public stream anchor:", anchor);
    console.log("Created public stream payroll:", payroll);
    return params.streamId;
}

async function pauseStream(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStream(streamId, undefined, { priorityFee: 0.1 });
    console.log("Pause stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream paused?", anchor.paused, "at", anchor.lastPausedTime);
}

async function resumeStream(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStream(streamId, undefined, { priorityFee: 0.1 });
    console.log("Resume stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream paused?", anchor.paused, "paused interval:", anchor.pausedInterval);
}

async function pauseStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPublic(streamId, { priorityFee: 0.1 });
    console.log("Pause public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream paused?", anchor.paused, "at", anchor.lastPausedTime);
}

async function resumeStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPublic(streamId, { priorityFee: 0.1 });
    console.log("Resume public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream paused?", anchor.paused, "paused interval:", anchor.pausedInterval);
}

async function withdraw(streamId: string | bigint) {
    const preview = await receiverClient.getWithdrawableAmounts(streamId);
    console.log("Withdrawable preview:", preview);
    const txId = await receiverClient.withdraw(streamId, undefined, undefined, { priorityFee: 0.1 });
    console.log("Withdraw transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await receiverClient.getStreamAnchor(streamId);
    console.log("Withdrawn amount:", anchor.withdrawnAmount);
}

async function withdrawPublic(streamId: string | bigint) {
    const preview = await receiverClient.getWithdrawableAmounts(streamId);
    console.log("Public withdrawable preview:", preview);
    const txId = await receiverClient.withdrawPublic(streamId, undefined, undefined, { priorityFee: 0.1 });
    console.log("Withdraw public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await receiverClient.getStreamAnchor(streamId);
    console.log("Public withdrawn amount:", anchor.withdrawnAmount);
}

async function cancelStream(streamId: string | bigint) {
    const txId = await senderClient.cancelStream(streamId, undefined, undefined, { priorityFee: 0.1 });
    console.log("Cancel stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream canceled?", anchor.canceled, "at", anchor.canceledAt);
}

async function cancelStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.cancelStreamPublic(streamId, undefined, undefined, { priorityFee: 0.1 });
    console.log("Cancel public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream canceled?", anchor.canceled, "at", anchor.canceledAt);
}

async function main() {
    const publicMode = process.env.PUBLIC_STREAM === "1";
    console.log("Public mode is enabled.");
    let start = Date.now();
    const streamId = publicMode ? await createStreamPublic() : await createStreamPrivate();
    let end = Date.now();
    console.log(`Stream creation took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Pausing stream...");
    start = Date.now();
    if (publicMode) {
        await pauseStreamPublic(streamId);
    } else {
        await pauseStream(streamId);
    }
    end = Date.now();
    console.log(`Stream pause took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Resuming stream...");
    start = Date.now();
    if (publicMode) {
        await resumeStreamPublic(streamId);
    } else {
        await resumeStream(streamId);
    }
    end = Date.now();
    console.log(`Stream resume took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Withdrawing from stream...");
    start = Date.now();
    if (publicMode) {
        await withdrawPublic(streamId);
    } else {
        await withdraw(streamId);
    }
    end = Date.now();
    console.log(`Stream withdraw took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Canceling stream...");
    start = Date.now();
    if (publicMode) {
        await cancelStreamPublic(streamId);
    } else {
        await cancelStream(streamId);
    }
    end = Date.now();
    console.log(`Stream cancel took ${(end - start) / 1000} seconds`);
    console.log("Payroll stream lifecycle completed successfully.");
    console.log("Stream created with ID:", streamId);
}

await main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
