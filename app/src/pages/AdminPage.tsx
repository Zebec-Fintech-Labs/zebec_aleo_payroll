import { useCallback, useEffect, useState } from "react";
import type { PayrollConfig } from "../../../sdk/types.ts";
import { CONFIG_NAME, DEFAULT_FEE, TOKEN_PROGRAM } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { parseBig, parseFee, requirePrefix } from "./form.ts";

interface ConfigState {
  config?: PayrollConfig;
  whitelisted?: boolean;
}

export default function AdminPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, service } = payroll;

  const [state, setState] = useState<ConfigState>({});
  const [readNote, setReadNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (service === null) return;
    setReadNote(null);
    const next: ConfigState = {};
    try {
      next.config = await service.getPayrollConfig(CONFIG_NAME);
    } catch {
      setReadNote("payroll config is not initialized on-chain");
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
