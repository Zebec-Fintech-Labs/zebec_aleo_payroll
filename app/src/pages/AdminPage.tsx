import { useCallback, useEffect, useState } from "react";
import type { FeeTier, PayrollConfig } from "../../../sdk/types.ts";
import { CONFIG_NAME, DEFAULT_FEE, TOKEN_PROGRAM } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { parseBig, parseFee, requirePrefix } from "./form.ts";

interface ConfigState {
  config?: PayrollConfig;
  tiers: FeeTier[];
  whitelisted?: boolean;
}

export default function AdminPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, service } = payroll;

  const [state, setState] = useState<ConfigState>({ tiers: [] });
  const [readNote, setReadNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (service === null) return;
    setReadNote(null);
    const next: ConfigState = { tiers: [] };
    try {
      next.config = await service.getPayrollConfig(CONFIG_NAME);
    } catch {
      setReadNote("payroll config is not initialized on-chain");
    }
    for (let index = 0; index < 8; index++) {
      try {
        next.tiers.push(await service.getFeeTier(CONFIG_NAME, index));
      } catch {
        break;
      }
    }
    next.whitelisted = await service.isTokenWhitelisted(CONFIG_NAME, TOKEN_PROGRAM);
    setState(next);
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <section className="card">
        <h2>Current config</h2>
        <div className="row-actions" style={{ marginBottom: "0.75rem" }}>
          <button className="action secondary" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
        </div>
        {readNote !== null && <p className="form-error">{readNote}</p>}
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          config name: {CONFIG_NAME}
        </p>
        {state.config !== undefined && (
          <dl className="kv">
            <dt>admin</dt>
            <dd>{state.config.admin}</dd>
            <dt>fee vault</dt>
            <dd>{state.config.feeVault}</dd>
            <dt>withdrawer</dt>
            <dd>{state.config.withdrawer}</dd>
            <dt>base fee</dt>
            <dd>{state.config.baseFee.toString()} microcredits</dd>
            <dt>platform fee</dt>
            <dd>{state.config.platformFee.toString()} microcredits</dd>
          </dl>
        )}
        <h2 style={{ marginTop: "1rem" }}>Fee tiers</h2>
        {state.tiers.length === 0 ? (
          <p className="muted">No fee tiers set.</p>
        ) : (
          <table className="streams">
            <thead>
              <tr>
                <th>#</th>
                <th>Min (USD, 6dp)</th>
                <th>Max (USD, 6dp)</th>
                <th>Fee (bps)</th>
              </tr>
            </thead>
            <tbody>
              {state.tiers.map((t, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  <td>{t.minAmount.toString()}</td>
                  <td>{t.maxAmount.toString()}</td>
                  <td>{t.feeBps.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {TOKEN_PROGRAM} whitelisted:{" "}
          {state.whitelisted === undefined ? "?" : state.whitelisted ? "yes" : "no"}
        </p>
      </section>

      <ConfigForm
        title="Initialize config"
        submitLabel="Initialize"
        busy={busy}
        onSubmit={async (feeVault, withdrawer, baseFee, platformFee, fee) =>
          runTx(async (svc) => {
            const txId = await svc.initializeConfig(feeVault, withdrawer, baseFee, platformFee, fee);
            await svc.waitForConfirmation(txId);
          }).then(() => refresh())
        }
      />
      <ConfigForm
        title="Update config"
        submitLabel="Update"
        busy={busy}
        onSubmit={async (feeVault, withdrawer, baseFee, platformFee, fee) =>
          runTx(async (svc) => {
            const txId = await svc.updateConfig(feeVault, withdrawer, baseFee, platformFee, fee);
            await svc.waitForConfirmation(txId);
          }).then(() => refresh())
        }
      />
      <FeeTierForm busy={busy} runTx={runTx} onDone={refresh} />
      <WhitelistForm busy={busy} runTx={runTx} onDone={refresh} />
    </>
  );
}

function ConfigForm({
  title,
  submitLabel,
  busy,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (
    feeVault: string,
    withdrawer: string,
    baseFee: bigint,
    platformFee: bigint,
    fee: number,
  ) => Promise<void>;
}) {
  const [feeVault, setFeeVault] = useState("");
  const [withdrawer, setWithdrawer] = useState("");
  const [baseFee, setBaseFee] = useState("10000");
  const [platformFee, setPlatformFee] = useState("100000");
  const [fee, setFee] = useState(String(DEFAULT_FEE));
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDone(false);
    try {
      const vault = requirePrefix(feeVault, "aleo1", "fee vault");
      const wd = requirePrefix(withdrawer, "aleo1", "withdrawer");
      const base = parseBig(baseFee, "base fee");
      const platform = parseBig(platformFee, "platform fee");
      const feeMicro = parseFee(fee);
      await onSubmit(vault, wd, base, platform, feeMicro);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card">
      <h2>{title}</h2>
      <form className="grid" onSubmit={handle}>
        <label className="field">
          Fee vault address
          <input value={feeVault} onChange={(e) => setFeeVault(e.target.value)} placeholder="aleo1..." disabled={busy} />
        </label>
        <label className="field">
          Withdrawer address
          <input value={withdrawer} onChange={(e) => setWithdrawer(e.target.value)} placeholder="aleo1..." disabled={busy} />
        </label>
        <label className="field">
          Base fee (microcredits)
          <input value={baseFee} onChange={(e) => setBaseFee(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Platform fee (microcredits)
          <input value={platformFee} onChange={(e) => setPlatformFee(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Tx fee (microcredits)
          <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
        </label>
        {formError !== null && <p className="form-error">{formError}</p>}
        <div className="full">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Working..." : submitLabel}
          </button>
          {done && <span className="result" style={{ marginLeft: "0.75rem" }}>confirmed</span>}
        </div>
      </form>
    </section>
  );
}

function FeeTierForm({
  busy,
  runTx,
  onDone,
}: {
  busy: boolean;
  runTx: UsePayroll["runTx"];
  onDone: () => Promise<void>;
}) {
  const [index, setIndex] = useState("0");
  const [minAmount, setMinAmount] = useState("0");
  const [maxAmount, setMaxAmount] = useState("1000000000");
  const [feeBps, setFeeBps] = useState("25");
  const [fee, setFee] = useState(String(DEFAULT_FEE));
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDone(false);
    let idx: number;
    let tier: FeeTier;
    let feeMicro: number;
    try {
      idx = Number(parseBig(index, "tier index"));
      if (!Number.isInteger(idx) || idx < 0 || idx > 255) throw new Error("tier index must be 0-255");
      tier = {
        minAmount: parseBig(minAmount, "min amount"),
        maxAmount: parseBig(maxAmount, "max amount"),
        feeBps: parseBig(feeBps, "fee bps"),
      };
      feeMicro = parseFee(fee);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }
    const ok = await runTx(async (svc) => {
      const txId = await svc.setFeeTier(idx, tier, feeMicro);
      await svc.waitForConfirmation(txId);
    });
    if (ok !== undefined) {
      setDone(true);
      await onDone();
    }
  };

  return (
    <section className="card">
      <h2>Set fee tier</h2>
      <form className="grid" onSubmit={handle}>
        <label className="field">
          Tier index
          <input value={index} onChange={(e) => setIndex(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Fee (bps)
          <input value={feeBps} onChange={(e) => setFeeBps(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Min amount (USD, 6dp)
          <input value={minAmount} onChange={(e) => setMinAmount(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Max amount (USD, 6dp)
          <input value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          Tx fee (microcredits)
          <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
        </label>
        {formError !== null && <p className="form-error">{formError}</p>}
        <div className="full">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Working..." : "Set fee tier"}
          </button>
          {done && <span className="result" style={{ marginLeft: "0.75rem" }}>confirmed</span>}
        </div>
      </form>
    </section>
  );
}

function WhitelistForm({
  busy,
  runTx,
  onDone,
}: {
  busy: boolean;
  runTx: UsePayroll["runTx"];
  onDone: () => Promise<void>;
}) {
  const [tokenProgram, setTokenProgram] = useState(TOKEN_PROGRAM);
  const [allowed, setAllowed] = useState(true);
  const [fee, setFee] = useState(String(DEFAULT_FEE));
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDone(false);
    let feeMicro: number;
    try {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(tokenProgram.trim())) {
        throw new Error("token program must be a bare Leo identifier (e.g. test_usdcx_stablecoin)");
      }
      feeMicro = parseFee(fee);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }
    const ok = await runTx(async (svc) => {
      const txId = await svc.setTokenWhitelisted(tokenProgram.trim(), allowed, feeMicro);
      await svc.waitForConfirmation(txId);
    });
    if (ok !== undefined) {
      setDone(true);
      await onDone();
    }
  };

  return (
    <section className="card">
      <h2>Set token whitelisted</h2>
      <form className="grid" onSubmit={handle}>
        <label className="field">
          Token program id (bare identifier)
          <input value={tokenProgram} onChange={(e) => setTokenProgram(e.target.value)} disabled={busy} />
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={allowed}
            onChange={(e) => setAllowed(e.target.checked)}
            disabled={busy}
          />
          Allowed
        </label>
        <label className="field">
          Tx fee (microcredits)
          <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
        </label>
        {formError !== null && <p className="form-error">{formError}</p>}
        <div className="full">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Working..." : "Set whitelist"}
          </button>
          {done && <span className="result" style={{ marginLeft: "0.75rem" }}>confirmed</span>}
        </div>
      </form>
    </section>
  );
}
