import { useCallback, useEffect, useState } from "react";
import type {
  Payroll,
  PayrollConfig,
  StreamAnchor,
} from "../../../sdk/types.ts";
import type { WithdrawableAmounts } from "../../../sdk/math.ts";
import { CONFIG_NAME, DEFAULT_FEE, TOKEN_PROGRAM } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { loadKnownStreamIds, addKnownStreamId } from "./publicStreamStore.ts";
import { fieldLiteral } from "../../../sdk/plaintext.ts";
import { parseBig, parseFee, requirePrefix } from "./form.ts";

interface ConfigState {
  config?: PayrollConfig;
  whitelisted?: boolean;
}

/** A stream the wallet holds a WithdrawerPayrollTicket for (private auto-withdraw). */
interface WithdrawerRow {
  streamId: string;
  anchor?: StreamAnchor;
  withdrawable?: WithdrawableAmounts;
  note?: string;
}

/** A known public stream (public auto-withdraw). */
interface PublicWithdrawRow {
  streamId: string;
  payroll?: Payroll;
  anchor?: StreamAnchor;
  withdrawable?: WithdrawableAmounts;
  note?: string;
}

function anchorStatus(anchor: StreamAnchor): string {
  if (anchor.canceled) return "canceled";
  if (anchor.paused) return "paused";
  return "active";
}

export default function AdminPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, service, address } = payroll;

  const [state, setState] = useState<ConfigState>({});
  const [readNote, setReadNote] = useState<string | null>(null);

  // Auto-withdraw state.
  const [withdrawerRows, setWithdrawerRows] = useState<WithdrawerRow[]>([]);
  const [publicRows, setPublicRows] = useState<PublicWithdrawRow[]>([]);
  const [withdrawNote, setWithdrawNote] = useState<string | null>(null);
  const [manualStreamId, setManualStreamId] = useState("");

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

  /** Load the withdrawer's private tickets and the known public streams. */
  const refreshWithdrawLists = useCallback(async () => {
    if (service === null || address === null) return;
    setWithdrawNote(null);
    // Private: streams the wallet holds a WithdrawerPayrollTicket for.
    try {
      const tickets = await service.listMyTickets();
      const rows: WithdrawerRow[] = [];
      for (const ticket of tickets.filter((t) => t.kind === "WithdrawerPayrollTicket")) {
        try {
          const anchor = await service.getStreamAnchor(ticket.streamId);
          let withdrawable: WithdrawableAmounts | undefined;
          try {
            withdrawable = await service.getWithdrawableAmounts(ticket.streamId);
          } catch {
            withdrawable = undefined;
          }
          rows.push({
            streamId: ticket.streamId,
            anchor,
            ...(withdrawable !== undefined ? { withdrawable } : {}),
          });
        } catch {
          rows.push({ streamId: ticket.streamId, note: "no on-chain anchor" });
        }
      }
      setWithdrawerRows(rows);
    } catch (e) {
      console.error("List withdrawer tickets error:", e);
      setWithdrawNote(e instanceof Error ? e.message : String(e));
    }
    // Public: known stream ids from the shared store.
    const ids = loadKnownStreamIds(address);
    const prows: PublicWithdrawRow[] = [];
    for (const streamId of ids) {
      try {
        const payrollInfo = await service.getPayroll(streamId);
        const anchor = await service.getStreamAnchor(streamId);
        let withdrawable: WithdrawableAmounts | undefined;
        try {
          withdrawable = await service.getWithdrawableAmounts(streamId);
        } catch {
          withdrawable = undefined;
        }
        prows.push({
          streamId,
          payroll: payrollInfo,
          anchor,
          ...(withdrawable !== undefined ? { withdrawable } : {}),
        });
      } catch {
        prows.push({ streamId, note: "no on-chain payroll/anchor found" });
      }
    }
    setPublicRows(prows);
  }, [service, address]);

  useEffect(() => {
    void refreshWithdrawLists();
  }, [refreshWithdrawLists]);

  const onAddManualStream = (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawNote(null);
    if (address === null) return;
    let id: string;
    try {
      id = fieldLiteral(manualStreamId);
    } catch (err) {
      setWithdrawNote(err instanceof Error ? err.message : String(err));
      return;
    }
    addKnownStreamId(address, id);
    setManualStreamId("");
    void refreshWithdrawLists();
  };

  const onAutoWithdrawPrivate = async (streamId: string) => {
    await runTx(async (svc) => {
      const config = await svc.getConfigInput();
      const txId = await svc.withdrawAuto(streamId, config);
      await svc.waitForConfirmation(txId);
    });
    await refreshWithdrawLists();
  };

  const onAutoWithdrawPublic = async (streamId: string) => {
    await runTx(async (svc) => {
      const config = await svc.getConfigInput();
      const txId = await svc.withdrawAutoPublic(streamId, config);
      await svc.waitForConfirmation(txId);
    });
    await refreshWithdrawLists();
  };

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

      <section className="card">
        <h2>Auto-withdraw (private streams)</h2>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Streams this wallet holds a withdrawer ticket for. The connected wallet
          must be the config's withdrawer.
        </p>
        {withdrawerRows.length === 0 ? (
          <p className="muted">No withdrawer tickets found in this wallet.</p>
        ) : (
          <table className="streams">
            <thead>
              <tr>
                <th>Stream id</th>
                <th>Status</th>
                <th>Withdrawable now</th>
                <th>Withdrawn / Deposited</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {withdrawerRows.map((s) => (
                <tr key={s.streamId}>
                  <td>{s.streamId}field</td>
                  <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                  <td>
                    {s.withdrawable !== undefined
                      ? s.withdrawable.currentlyWithdrawable.toString()
                      : "—"}
                  </td>
                  <td>
                    {s.anchor !== undefined
                      ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                      : "—"}
                  </td>
                  <td>
                    <button
                      className="action"
                      onClick={() => void onAutoWithdrawPrivate(s.streamId)}
                      disabled={
                        busy ||
                        s.anchor === undefined ||
                        s.anchor.canceled ||
                        s.withdrawable === undefined ||
                        s.withdrawable.currentlyWithdrawable <= 0n
                      }
                    >
                      Auto-withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Auto-withdraw (public streams)</h2>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Known public streams (shared with the employer/employee pages). The
          connected wallet must be the config's withdrawer.
        </p>
        <form className="row-actions" style={{ marginBottom: "0.75rem" }} onSubmit={onAddManualStream}>
          <input
            value={manualStreamId}
            onChange={(e) => setManualStreamId(e.target.value)}
            placeholder="stream id (e.g. 42field)"
            disabled={busy}
          />
          <button
            className="action secondary"
            type="submit"
            disabled={busy || manualStreamId.trim() === ""}
          >
            Add stream
          </button>
          <button
            className="action secondary"
            type="button"
            onClick={() => void refreshWithdrawLists()}
            disabled={busy}
          >
            Refresh
          </button>
        </form>
        {withdrawNote !== null && <p className="form-error">{withdrawNote}</p>}
        {publicRows.length === 0 ? (
          <p className="muted">
            No known public streams yet. Add a stream id above to manage it here.
          </p>
        ) : (
          <table className="streams">
            <thead>
              <tr>
                <th>Stream id</th>
                <th>Status</th>
                <th>Withdrawable now</th>
                <th>Withdrawn / Deposited</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {publicRows.map((s) => (
                <tr key={s.streamId}>
                  <td>{s.streamId}</td>
                  <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                  <td>
                    {s.withdrawable !== undefined
                      ? s.withdrawable.currentlyWithdrawable.toString()
                      : "—"}
                  </td>
                  <td>
                    {s.anchor !== undefined
                      ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                      : "—"}
                  </td>
                  <td>
                    <button
                      className="action"
                      onClick={() => void onAutoWithdrawPublic(s.streamId)}
                      disabled={
                        busy ||
                        s.anchor === undefined ||
                        s.anchor.canceled ||
                        s.withdrawable === undefined ||
                        s.withdrawable.currentlyWithdrawable <= 0n
                      }
                    >
                      Auto-withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
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
