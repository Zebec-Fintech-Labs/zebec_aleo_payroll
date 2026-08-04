/**
 * Live testnet integration tests.
 *
 * These run only when `AACS_TEST_PRIVATE_KEY` is set to a funded testnet
 * private key. They exercise the admin configuration lifecycle end-to-end:
 *
 *   (optionally deploy) -> initialize_config -> set_fee_tier
 *   -> set_token_whitelisted -> update_config, verifying state via the
 *   client's read methods after each step.
 *
 * Environment variables:
 * - AACS_TEST_PRIVATE_KEY (required): funded testnet private key.
 * - AACS_TEST_HOST (optional): API host, defaults to the testnet explorer.
 * - AACS_DEPLOY=1 (optional): deploy `aacs_payroll_v2.aleo` first when it is
 *   not found on the network (costs a deployment fee).
 *
 * Stream-lifecycle transactions (create/pause/withdraw/cancel) are not
 * covered here: they additionally require a deployed IARC22 token program,
 * funded token records, and valid Sealance merkle proofs.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "mocha";

import {
  configNameToField,
  PayrollClient,
  DEFAULT_ENDPOINT,
} from "../../sdk/index.js";

import dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.warn("AACS_TEST_PRIVATE_KEY is not set; skipping integration tests.");
}
const HOST = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;

const here = path.dirname(fileURLToPath(import.meta.url));

const PROGRAM_SOURCE = readFileSync(
  path.resolve(here, "../../build/aacs_payroll_v2/aacs_payroll_v2.aleo"),
  "utf8",
);

// Random per-run config name so reruns don't collide with existing configs.
const CONFIG_NAME = configNameToField(`aacs-itest-${randomBytes(8).toString("hex")}`);

describe("testnet integration: admin lifecycle", function () {
  if (!PRIVATE_KEY) {
    it("is skipped (set PRIVATE_KEY to run)", function () {
      this.skip();
    });
    return;
  }

  this.timeout(600_000);

  const client = new PayrollClient({
    host: HOST,
    privateKey: PRIVATE_KEY,
    programSource: PROGRAM_SOURCE,
  });
  const admin = client.account!.address().to_string();
  const TIER = { minAmount: 0n, maxAmount: 1_000_000_000n, feeBps: 25n };
  const TOKEN = "my_token";

  async function waitForConfirmation(txId: string) {
    await client.networkClient.waitForTransactionConfirmation(txId);
  }

  it("initializes a payroll config", async () => {
    const txId = await client.initializeConfig(CONFIG_NAME, admin, admin, 1_000n, 2_000n);
    await waitForConfirmation(txId);
    const config = await client.getPayrollConfig(CONFIG_NAME);
    assert.equal(config.admin, admin);
    assert.equal(config.feeVault, admin);
    assert.equal(config.withdrawer, admin);
    assert.equal(config.baseFee, 1_000n);
    assert.equal(config.platformFee, 2_000n);
    assert.equal(config.initialized, true);
  });

  it("sets and reads a fee tier", async () => {
    const txId = await client.setFeeTier(CONFIG_NAME, 0, TIER);
    await waitForConfirmation(txId);
    assert.deepEqual(await client.getFeeTier(CONFIG_NAME, 0), TIER);
  });

  it("whitelists and de-whitelists a token", async () => {
    assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), false);
    const txId = await client.setTokenWhitelisted(CONFIG_NAME, TOKEN, true);
    await waitForConfirmation(txId);
    assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), true);
    const txId2 = await client.setTokenWhitelisted(CONFIG_NAME, TOKEN, false);
    await waitForConfirmation(txId2);
    assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), false);
  });

  it("updates the config", async () => {
    const txId = await client.updateConfig(CONFIG_NAME, admin, admin, 3_000n, 4_000n);
    await waitForConfirmation(txId);
    const config = await client.getPayrollConfig(CONFIG_NAME);
    assert.equal(config.baseFee, 3_000n);
    assert.equal(config.platformFee, 4_000n);
  });
});
