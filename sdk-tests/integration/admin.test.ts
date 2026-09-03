/**
 * Live testnet integration tests.
 *
 * These run only when `PRIVATE_KEY` is set to a funded testnet private key
 * (plus `PROVER_API_KEY` / `PROVER_CONSUMER_ID` for the delegated proving and
 * record scanning services used by `createAleoWallet`). They exercise the
 * admin configuration lifecycle end-to-end:
 *
 *   initialize_config -> set_token_whitelisted -> update_config, verifying
 *   state via the client's read methods after each step.
 *
 * Environment variables:
 * - PRIVATE_KEY (required): funded testnet private key.
 * - ENDPOINT (optional): API host, defaults to the testnet explorer.
 *
 * Stream-lifecycle transactions (create/pause/withdraw/cancel) are not
 * covered here: they additionally require funded token records and valid
 * Sealance merkle proofs.
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, it, before } from "mocha";

import {
  configNameToField,
  createAleoWallet,
  Network,
  StreamClient,
  DEFAULT_ENDPOINT,
} from "../../sdk/index.js";

import dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.warn("PRIVATE_KEY is not set; skipping integration tests.");
}
const HOST = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;

// Random per-run config name so reruns don't collide with existing configs.
const CONFIG_NAME = configNameToField(`zebec-itest-${randomBytes(8).toString("hex")}`);

describe("testnet integration: admin lifecycle", function () {
  if (!PRIVATE_KEY) {
    it("is skipped (set PRIVATE_KEY to run)", function () {
      this.skip();
    });
    return;
  }

  this.timeout(600_000);

  let client: StreamClient;
  let admin: string;
  const TOKEN = "my_token";

  before(async () => {
    const wallet = await createAleoWallet(PRIVATE_KEY, Network.TESTNET, { host: HOST });
    client = new StreamClient(wallet, { host: HOST });
    admin = wallet.address;
  });

  async function waitForConfirmation(txId: string) {
    await client.networkClient.waitForTransactionConfirmation(txId);
  }

  it("initializes a stream config", async () => {
    const txId = await client.initializeConfig({
      configName: CONFIG_NAME,
      admin,
      feeVault: admin,
      withdrawer: admin,
      baseFee: "0.001",
      platformFee: "0.002",
    });
    await waitForConfirmation(txId);
    const config = await client.getStreamConfig(CONFIG_NAME);
    assert.equal(config.admin, admin);
    assert.equal(config.feeVault, admin);
    assert.equal(config.withdrawer, admin);
    assert.equal(config.baseFee, "0.001");
    assert.equal(config.platformFee, "0.002");
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
    const txId = await client.updateConfig({
      configName: CONFIG_NAME,
      admin,
      feeVault: admin,
      withdrawer: admin,
      baseFee: "0.003",
      platformFee: "0.004",
    });
    await waitForConfirmation(txId);
    const config = await client.getStreamConfig(CONFIG_NAME);
    assert.equal(config.baseFee, "0.003");
    assert.equal(config.platformFee, "0.004");
  });
});
