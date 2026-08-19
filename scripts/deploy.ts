import { Account, AleoKeyProvider, initThreadPool, ProgramManager } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();

await initThreadPool();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
const HOST = "https://api.explorer.provable.com/v1";
console.log("Host:", HOST);
const here = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_SOURCE = fs.readFileSync(
    path.resolve(here, "../build/test_zebec_payroll_v5/test_zebec_payroll_v5.aleo"),
    "utf8",
);
// console.log("Program source loaded:\n", PROGRAM_SOURCE, "\n");

const account = new Account({ privateKey: PRIVATE_KEY });

// Create a network client to connect to the Aleo network.
// const networkClient = new AleoNetworkClient(HOST);
// Create a key provider that will be used to find public proving & verifying keys for Aleo programs.
const keyProvider = new AleoKeyProvider();
keyProvider.useCache(true);
// Initialize a program manager to talk to the Aleo network with the configured key provider.
const programManager = new ProgramManager(HOST, keyProvider);
// Set the account for the program manager.
programManager.setAccount(account);
// const imports = await networkClient.getProgramImports(PROGRAM_SOURCE);
// console.log("Program imports:", imports);
// Define a fee to pay to deploy the program
const fee = 2;
// Build a deployment transaction for the program.
const tx = await programManager.buildDeploymentTransaction(PROGRAM_SOURCE, fee, false);
console.log("Transaction ID:", tx.id());
// Send the transaction to the network until it is confirmed.
let confirmed = false;
let transaction_id = tx.id();
const submitTransactionWithRetry = async () => {
    while (!confirmed) {
        try {
            transaction_id = await programManager.networkClient.submitTransaction(tx);
            console.log("Transaction ID:", transaction_id);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            if (error instanceof Error && error.message.includes(`Transaction '${transaction_id}' already exists in the ledger`)) {
                console.log("Transaction already exists in the ledger.");
                break;
            }
        }
    }
}

const waitForConfirmation = async () => {
    const transactionStatus = await programManager.networkClient.waitForTransactionConfirmation(transaction_id);
    console.log("Transaction Status:", transactionStatus.status);
    if (transactionStatus.status.toLowerCase() === "accepted") {
        confirmed = true;
        console.log("Transaction confirmed successfully.");
    }
}

await Promise.all([submitTransactionWithRetry(), waitForConfirmation()]);