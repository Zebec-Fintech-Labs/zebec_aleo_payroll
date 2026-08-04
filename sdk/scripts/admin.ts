import { initThreadPool, } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { configNameToField, PayrollClient } from "../src/index.js";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";

dotenv.config();

await initThreadPool();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
const HOST = "https://api.explorer.provable.com/v1";

const here = path.dirname(fileURLToPath(import.meta.url));
console.log("Current directory:", here);
const PROGRAM_SOURCE = fs.readFileSync(
    path.resolve(here, "../../build/aacs_payroll/aacs_payroll.aleo"),
    "utf8",
);

const client = new PayrollClient({
    host: HOST,
    privateKey: PRIVATE_KEY,
    programSource: PROGRAM_SOURCE,
});
const admin = client.account!.address().to_string();
console.log("Admin address:", admin);
const CONFIG_NAME = configNameToField(`Payroll_Config_001`);

async function waitForConfirmation(txId: string) {
    const confirmation = await client.networkClient.waitForTransactionConfirmation(txId, 2_000, 60_000);
    const confirmationStatus = confirmation.status;
    if (confirmationStatus.toLowerCase() !== "accepted") {
        throw new Error(`Transaction ${txId} failed with status: ${confirmationStatus}`);
    }
}

async function initializePayrollConfig() {
    const FEE_VAULT = admin;
    const WITHDRAWER = admin;
    const BASE_FEE = 10_000n;
    const PLATFORM_FEE = 100_000n;

    const txId = await client.initializeConfig(CONFIG_NAME, FEE_VAULT, WITHDRAWER, BASE_FEE, PLATFORM_FEE, {
        priorityFee: 0.1,
    });
    console.log("Config Initialization transaction ID:", txId);
    await waitForConfirmation(txId);
    const config = await client.getPayrollConfig(CONFIG_NAME);
    console.log("Initialized config:", config);
}

async function updatePayrollConfig() {
    const FEE_VAULT = admin;
    const WITHDRAWER = admin;
    const BASE_FEE = 100_000n;
    const PLATFORM_FEE = 1_000_000n;

    const txId = await client.updateConfig(CONFIG_NAME, FEE_VAULT, WITHDRAWER, BASE_FEE, PLATFORM_FEE, {
        priorityFee: 0.1,
    });
    console.log("Config Update transaction ID:", txId);
    await waitForConfirmation(txId);
    const config = await client.getPayrollConfig(CONFIG_NAME);
    console.log("Updated config:", config);
}

async function setFeeTiers() {
    const TIERS = [
        { minAmount: 0n, maxAmount: 1_000_000_000n, feeBps: 25n },
        { minAmount: 1_000_000_001n, maxAmount: 10_000_000_000n, feeBps: 20n },
        { minAmount: 10_000_000_001n, maxAmount: 100_000_000_000n, feeBps: 15n }
    ];

    for (let index = 0; index < TIERS.length; index++) {
        const tier = TIERS[index];
        const txId = await client.setFeeTier(CONFIG_NAME, index, tier, {
            priorityFee: 0.1,
        });
        console.log(`Fee tier ${index} transaction ID:`, txId);
        await waitForConfirmation(txId);
        await setTimeout(2000);
        console.log(`Set fee tier ${index}:`, tier);
        const retrievedTier = await client.getFeeTier(CONFIG_NAME, index);
        console.log(`Retrieved fee tier ${index}:`, retrievedTier);
    }
}

async function whitelistTokens() {
    const TOKENS = ["test_usdcx_stablecoin.aleo", "test_usad_stablecoin.aleo"];
    const ALLOWED = true;

    for (const token of TOKENS) {
        const txId = await client.setTokenWhitelisted(CONFIG_NAME, token, ALLOWED, {
            priorityFee: 0.1,
        });
        console.log(`Whitelist token ${token} transaction ID:`, txId);
        await waitForConfirmation(txId);
        await setTimeout(2000);
        const isWhitelisted = await client.isTokenWhitelisted(CONFIG_NAME, token);
        console.log(`Is token ${token} whitelisted?`, isWhitelisted);
    }
}

async function main() {
    // await initializePayrollConfig();
    // await updatePayrollConfig();
    // await setFeeTiers();
    await whitelistTokens();
}

await main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});