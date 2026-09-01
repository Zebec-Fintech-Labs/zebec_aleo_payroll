import { initThreadPool, } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { configNameToField, StreamClient } from "../sdk/index.js";
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
    path.resolve(here, "../build/test_zebec_stream_v3/test_zebec_stream_v3.aleo"),
    "utf8",
);

const client = new StreamClient({
    host: HOST,
    privateKey: PRIVATE_KEY,
    programSource: PROGRAM_SOURCE,
});
const admin = client.account!.address().to_string();
console.log("Admin address:", admin);
const CONFIG_NAME = configNameToField(`Stream_Config_001`);

async function waitForConfirmation(txId: string) {
    const confirmation = await client.networkClient.waitForTransactionConfirmation(txId, 2_000, 60_000);
    const confirmationStatus = confirmation.status;
    if (confirmationStatus.toLowerCase() !== "accepted") {
        throw new Error(`Transaction ${txId} failed with status: ${confirmationStatus}`);
    }
}

async function initializeStreamConfig() {
    const FEE_VAULT = admin;
    const WITHDRAWER = admin;
    const BASE_FEE = 10_000n;
    const PLATFORM_FEE = 100_000n;

    const txId = await client.initializeConfig(CONFIG_NAME, FEE_VAULT, WITHDRAWER, BASE_FEE, PLATFORM_FEE, {
        priorityFee: 0.1,
    });
    console.log("Config Initialization transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(10000);
    const config = await client.getStreamConfig(CONFIG_NAME);
    console.log("Initialized config:", config);
}

async function updateStreamConfig() {
    const FEE_VAULT = admin;
    const WITHDRAWER = admin;
    const BASE_FEE = 100_000n;
    const PLATFORM_FEE = 1_000_000n;

    const txId = await client.updateConfig(CONFIG_NAME, FEE_VAULT, WITHDRAWER, BASE_FEE, PLATFORM_FEE, {
        priorityFee: 0.1,
    });
    console.log("Config Update transaction ID:", txId);
    await waitForConfirmation(txId);
    const config = await client.getStreamConfig(CONFIG_NAME);
    console.log("Updated config:", config);
}

async function whitelistTokens() {
    const TOKENS = ["test_usdcx_stablecoin", "test_usad_stablecoin"];
    const ALLOWED = true;

    for (const token of TOKENS) {
        const txId = await client.setTokenWhitelisted(CONFIG_NAME, token, ALLOWED, {
            priorityFee: 0.1,
        });
        console.log(`Whitelist token ${token} transaction ID:`, txId);
        await waitForConfirmation(txId);
        await setTimeout(10000);
        const isWhitelisted = await client.isTokenWhitelisted(CONFIG_NAME, token);
        console.log(`Is token ${token} whitelisted?`, isWhitelisted);
    }
}

async function main() {
    await initializeStreamConfig();
    // await updateStreamConfig();
    await whitelistTokens();
}

await main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});