/**
 * Live testnet integration tests.
 *
 * These run only when `PRIVATE_KEY` is set to a funded testnet private key
 * (plus `PROVABLE_API_KEY` / `PROVABLE_CONSUMER_ID` for the delegated proving
 * and record scanning services used by `createAleoWallet`). They exercise the
 * admin configuration lifecycle end-to-end:
 *
 *   initialize_config -> set_token_whitelisted -> update_config, verifying
 *   state via the client's read methods after each step.
 *
 * Every write waits for confirmation **and then sleeps** before the next read:
 * a transaction is confirmed as soon as it is in a block, but the explorer's
 * mapping index trails that by several seconds, so an immediate read serves
 * the pre-write value. See `confirmWrite`.
 *
 * Environment variables:
 * - PRIVATE_KEY (required): funded testnet private key; becomes the config admin.
 * - SENDER_PRIVATE_KEY (optional): a second funded key, used for the
 *   unauthorized-caller cases. Those are skipped when it is unset.
 * - ENDPOINT (optional): API host, defaults to the testnet explorer.
 * - ONCHAIN_SETTLE_MS (optional): post-write settle time, defaults to 60s.
 *
 * Stream-lifecycle transactions (create/pause/withdraw/cancel) are not
 * covered here: they additionally require funded token records and valid
 * Sealance merkle proofs.
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
const OTHER_PRIVATE_KEY = process.env.SENDER_PRIVATE_KEY;
const HOST = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;

/**
 * How long to wait after a confirmed write before reading the mapping back.
 * Confirmation only means the transaction is in a block; the explorer's
 * mapping index lags behind it, so reading immediately returns stale data.
 */
const SETTLE_MS = Number(process.env.ONCHAIN_SETTLE_MS ?? 60_000);

/** Per-test budget: several sequential writes, each followed by a settle. */
const TEST_TIMEOUT_MS = 900_000;

// Random per-run config name so reruns don't collide with existing configs.
const CONFIG_NAME = configNameToField(`zebec-itest-${randomBytes(8).toString("hex")}`);

describe("testnet integration: admin lifecycle", function () {
  if (!PRIVATE_KEY) {
    it("is skipped (set PRIVATE_KEY to run)", function () {
      this.skip();
    });
    return;
  }

  this.timeout(TEST_TIMEOUT_MS);

  let client: StreamClient;
  let admin: string;
  const TOKEN = "my_token";

  before(async () => {
    const wallet = await createAleoWallet(PRIVATE_KEY, Network.TESTNET, { host: HOST });
    client = new StreamClient(wallet, { host: HOST });
    admin = wallet.address;
  });

  /**
   * Wait for `txId` to be confirmed, then give the explorer time to index the
   * new mapping state. Every read that follows a write must go through this.
   */
  async function confirmWrite(txId: string) {
    await client.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000);
    await sleep(SETTLE_MS);
  }

  /**
   * Submit a write that the on-chain `final` block is expected to reject, and
   * assert it was rejected rather than accepted. Rejected transactions leave
   * no state behind, but the fee is still charged.
   */
  async function expectRejected(submit: () => Promise<string>, what: string) {
    let txId: string;
    try {
      txId = await submit();
    } catch (error) {
      // Some nodes refuse the transaction at broadcast time instead.
      return `not broadcast: ${error instanceof Error ? error.message : String(error)}`;
    }
    await assert.rejects(
      client.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000),
      /rejected by the network/,
      `${what} should have been rejected on-chain (tx ${txId})`,
    );
    await sleep(SETTLE_MS);
    return txId;
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
    await confirmWrite(txId);
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
    await confirmWrite(txId);
    assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), true);
    const txId2 = await client.setTokenWhitelisted(CONFIG_NAME, TOKEN, false);
    await confirmWrite(txId2);
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
    await confirmWrite(txId);
    const config = await client.getStreamConfig(CONFIG_NAME);
    assert.equal(config.baseFee, "0.003");
    assert.equal(config.platformFee, "0.004");
  });

  // =========================================================================
  // Edge cases derived from `src/main.leo`
  //
  // These run after the lifecycle tests above, against the config they created.
  // =========================================================================

  describe("edge cases", function () {
    this.timeout(TEST_TIMEOUT_MS);

    it("keeps a config name unique", async () => {
      // `initialize_config` asserts `!stream_configs.contains(config_name)`,
      // so a second initialization must not overwrite the admin or the fees.
      await expectRejected(
        () =>
          client.initializeConfig({
            configName: CONFIG_NAME,
            admin,
            feeVault: admin,
            withdrawer: admin,
            baseFee: "9",
            platformFee: "9",
          }),
        "re-initializing an existing config",
      );
      const config = await client.getStreamConfig(CONFIG_NAME);
      assert.equal(config.admin, admin);
      assert.equal(config.baseFee, "0.003");
      assert.equal(config.platformFee, "0.004");
    });

    it("rejects an update to a config that was never initialized", async () => {
      // `update_config` hard-`get`s the entry, so an unknown name aborts.
      const unknown = configNameToField(`zebec-itest-missing-${randomBytes(8).toString("hex")}`);
      await expectRejected(
        () =>
          client.updateConfig({
            configName: unknown,
            admin,
            feeVault: admin,
            withdrawer: admin,
            baseFee: "0.001",
            platformFee: "0.002",
          }),
        "updating a nonexistent config",
      );
      await assert.rejects(client.getStreamConfig(unknown), /not found/);
    });

    it("accepts a zero base fee and a zero platform fee", async () => {
      // Nothing on-chain requires the fees to be positive; a config with both
      // at zero makes `compute_auto_withdrawal_fee` return 0.
      const txId = await client.updateConfig({
        configName: CONFIG_NAME,
        admin,
        feeVault: admin,
        withdrawer: admin,
        baseFee: "0",
        platformFee: "0",
      });
      await confirmWrite(txId);
      const config = await client.getStreamConfig(CONFIG_NAME);
      assert.equal(config.baseFee, "0");
      assert.equal(config.platformFee, "0");

      // Restore the fees for any later test in this file.
      const restore = await client.updateConfig({
        configName: CONFIG_NAME,
        admin,
        feeVault: admin,
        withdrawer: admin,
        baseFee: "0.003",
        platformFee: "0.004",
      });
      await confirmWrite(restore);
      assert.equal((await client.getStreamConfig(CONFIG_NAME)).baseFee, "0.003");
    });

    it("scopes the whitelist to one config", async () => {
      // The whitelist key is `BHP256(WhitelistKey { config, token_program })`,
      // so whitelisting under this config must not leak into another one.
      const txId = await client.setTokenWhitelisted(CONFIG_NAME, TOKEN, true);
      await confirmWrite(txId);
      assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), true);

      const otherConfig = configNameToField(`zebec-itest-other-${randomBytes(8).toString("hex")}`);
      assert.equal(await client.isTokenWhitelisted(otherConfig, TOKEN), false);
      // A different token under the same config is a different key too.
      assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, "my_other_token"), false);

      const cleanup = await client.setTokenWhitelisted(CONFIG_NAME, TOKEN, false);
      await confirmWrite(cleanup);
      assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, TOKEN), false);
    });

    it("reports unknown configs, streams and anchors as missing", async () => {
      // The `view fn`s assert `contains(...)`; the client's read methods
      // surface that as a rejection rather than a default value.
      const unknown = configNameToField(`zebec-itest-unknown-${randomBytes(8).toString("hex")}`);
      await assert.rejects(client.getStreamConfig(unknown), /not found/);
      await assert.rejects(client.getStream(unknown), /not found/);
      await assert.rejects(client.getStreamAnchor(unknown), /not found/);
    });

    it("reports empty registries for a config with no public streams", async () => {
      // `get_outgoing_stream_count` uses `get_or_use(key, 0u64)` and
      // `get_outgoing_stream_ref` returns `0field` for an absent slot.
      assert.equal(await client.getOutgoingStreamCount(admin, CONFIG_NAME), 0n);
      assert.equal(await client.getIncomingStreamCount(admin, CONFIG_NAME), 0n);
      assert.equal(await client.getOutgoingStreamRef(admin, CONFIG_NAME, 0), undefined);
      assert.deepEqual(await client.listPublicStreams(CONFIG_NAME), []);
    });

    it("rejects config writes from a non-admin", async function () {
      if (!OTHER_PRIVATE_KEY) this.skip();
      // `update_config` and `set_token_whitelisted` both assert
      // `config.admin == caller`.
      const otherWallet = await createAleoWallet(OTHER_PRIVATE_KEY, Network.TESTNET, {
        host: HOST,
      });
      assert.notEqual(otherWallet.address, admin, "SENDER_PRIVATE_KEY must differ from PRIVATE_KEY");
      const other = new StreamClient(otherWallet, { host: HOST });

      await expectRejected(
        () =>
          other.updateConfig({
            configName: CONFIG_NAME,
            admin,
            feeVault: otherWallet.address,
            withdrawer: otherWallet.address,
            baseFee: "9",
            platformFee: "9",
          }),
        "a non-admin config update",
      );
      await expectRejected(
        () => other.setTokenWhitelisted(CONFIG_NAME, "attacker_token", true),
        "a non-admin whitelist write",
      );

      const config = await client.getStreamConfig(CONFIG_NAME);
      assert.equal(config.feeVault, admin);
      assert.equal(config.baseFee, "0.003");
      assert.equal(await client.isTokenWhitelisted(CONFIG_NAME, "attacker_token"), false);
    });
  });
});
