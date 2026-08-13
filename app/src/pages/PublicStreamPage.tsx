import { useCallback, useEffect, useState } from "react";
import type { CreateStreamParams, Payroll, StreamAnchor } from "../../../sdk/types.ts";
import type { WithdrawableAmounts } from "../../../sdk/math.ts";
import { fieldLiteral } from "../../../sdk/plaintext.ts";
import { DEFAULT_FEE, TOKEN_PROGRAM, TOKEN_PROGRAM_ID } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { WalletArc22Service } from "../payroll/WalletArc22Service.ts";
import { parseBig, parseFee, randomField, requirePrefix } from "./form.ts";
import { addKnownStreamId, loadKnownStreamIds } from "./publicStreamStore.ts";

interface KnownStream {
  streamId: string;
  role: "sender" | "receiver" | "other";
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

export default function PublicStreamPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, runAsync, service, address } = payroll;

  // Create-stream form state.
  const [receiver, setReceiver] = useState("");
  const [amount, setAmount] = useState("2000000");
  const [duration, setDuration] = useState("600");
  const [startNow, setStartNow] = useState(true);
  const [startTime, setStartTime] = useState("");
  const [isCancelable, setIsCancelable] = useState(true);
  const [isPausable, setIsPausable] = useState(true);
  const [autoWithdrawable, setAutoWithdrawable] = useState(false);
  const [canTopup, setCanTopup] = useState(false);
  const [withdrawFrequency, setWithdrawFrequency] = useState("0");
  const [initialBufferAmount, setInitialBufferAmount] = useState("0");
  const [adminKey, setAdminKey] = useState("");
  const [fee, setFee] = useState(String(DEFAULT_FEE));
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Token allowance (prerequisite for create_stream_public).
  const [allowance, setAllowance] = useState<bigint | undefined>(undefined);
  const [tokenBalance, setTokenBalance] = useState<bigint | undefined>(undefined);
  const [approveAmount, setApproveAmount] = useState("0");
  const [allowanceNote, setAllowanceNote] = useState<string | null>(null);

  // Known public streams (localStorage-tracked; no ticket records exist).
  const [streams, setStreams] = useState<KnownStream[]>([]);
  const [listNote, setListNote] = useState<string | null>(null);
  const [manualStreamId, setManualStreamId] = useState("");

  const refreshAllowance = useCallback(async () => {
    if (service === null || address === null) return;
    setAllowanceNote(null);
    try {
      const arc22 = new WalletArc22Service(service.wallet, TOKEN_PROGRAM_ID);
      const [allowanceValue, balanceValue] = await Promise.all([
        arc22.getAllowance(address, service.getProgramAddress()),
        arc22.getBalanceOf(address),
      ]);
      setAllowance(allowanceValue);
      setTokenBalance(balanceValue);
    } catch (e) {
      setAllowance(undefined);
      setTokenBalance(undefined);
      setAllowanceNote(e instanceof Error ? e.message : String(e));
    }
  }, [service, address]);

  useEffect(() => {
    void refreshAllowance();
  }, [refreshAllowance]);

  const refreshStreams = useCallback(async () => {
    if (service === null || address === null) return;
    setListNote(null);
    const ids = loadKnownStreamIds(address);
    const rows: KnownStream[] = [];
    for (const streamId of ids) {
      try {
        const payrollInfo = await service.getPayroll(streamId);
        const anchor = await service.getStreamAnchor(streamId);
        const role: KnownStream["role"] =
          payrollInfo.sender === address
            ? "sender"
            : payrollInfo.receiver === address
              ? "receiver"
              : "other";
        let withdrawable: WithdrawableAmounts | undefined;
        if (role === "receiver") {
          try {
            withdrawable = await service.getWithdrawableAmounts(streamId);
          } catch {
            withdrawable = undefined;
          }
        }
        rows.push({
          streamId,
          role,
          payroll: payrollInfo,
          anchor,
          ...(withdrawable !== undefined ? { withdrawable } : {}),
        });
      } catch {
        rows.push({ streamId, role: "other", note: "no on-chain payroll/anchor found" });
      }
    }
    setStreams(rows);
  }, [service, address]);

  useEffect(() => {
    void refreshStreams();
  }, [refreshStreams]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setResult(null);
    let params: CreateStreamParams;
    let feeMicro: number;
    try {
      const startNowValue = startNow;
      const start = startNowValue
        ? 0n
        : parseBig(startTime, "start time (unix seconds)", { positive: true });
      if (!startNowValue && start <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new Error("start time is in the past");
      }
      params = {
        receiver: requirePrefix(receiver, "aleo1", "receiver"),
        streamId: randomField(),
        amount: parseBig(amount, "amount", { positive: true }),
        startTime: start,
        duration: parseBig(duration, "duration (seconds)", { positive: true }),
        isCancelable,
        isPausable,
        autoWithdrawable,
        withdrawFrequency: autoWithdrawable
          ? parseBig(withdrawFrequency, "withdraw frequency", { positive: true })
          : 0n,
        startNow: startNowValue,
        canTopup,
        initialBufferAmount: canTopup
          ? parseBig(initialBufferAmount, "initial buffer amount", { positive: true })
          : 0n,
      };
      feeMicro = parseFee(fee);
      requirePrefix(adminKey, "APrivateKey1", "admin attestation key");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }
    const anchor = await runTx(async (svc) => {
      const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
      // `create_stream_public` pulls the deposit via `transfer_from_public`,
      // which requires this program to be approved as the spender first.
      const arc22 = new WalletArc22Service(svc.wallet, TOKEN_PROGRAM_ID);
      const programAddress = svc.getProgramAddress();
      const allowanceValue = await arc22.getAllowance(svc.address, programAddress);
      if (allowanceValue < depositAmount) {
        const approveTxId = await arc22.approve(programAddress, depositAmount);
        setResult(`approve_public submitted: ${approveTxId}\nwaiting for confirmation...`);
        await arc22.waitForConfirmation(approveTxId);
      }
      const txId = await svc.createStreamPublic(params, adminKey.trim(), feeMicro);
      setResult(`create_stream_public submitted: ${txId}\nwaiting for confirmation...`);
      await svc.waitForConfirmation(txId);
      return svc.getStreamAnchor(params.streamId);
    });
    if (anchor !== undefined && address !== null) {
      setResult(
        `stream created: ${anchor.streamId}\nstatus: ${anchorStatus(anchor)}` +
          ` · deposited ${anchor.depositedAmount} · duration ${anchor.duration}s`,
      );
      setAdminKey("");
      addKnownStreamId(address, anchor.streamId);
      await refreshStreams();
      await refreshAllowance();
    }
  };

  const onApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    setAllowanceNote(null);
    let amountValue: bigint;
    try {
      amountValue = parseBig(approveAmount, "approve amount", { positive: true });
    } catch (err) {
      setAllowanceNote(err instanceof Error ? err.message : String(err));
      return;
    }
    if (service === null) return;
    const arc22 = new WalletArc22Service(service.wallet, TOKEN_PROGRAM_ID);
    const programAddress = service.getProgramAddress();
    await runAsync(async () => {
      const txId = await arc22.approve(programAddress, amountValue);
      setAllowanceNote(`approve_public submitted: ${txId}`);
      await arc22.waitForConfirmation(txId);
    });
    await refreshAllowance();
  };

  const onUnapprove = async (e: React.FormEvent) => {
    e.preventDefault();
    setAllowanceNote(null);
    let amountValue: bigint;
    try {
      amountValue = parseBig(approveAmount, "unapprove amount", { positive: true });
    } catch (err) {
      setAllowanceNote(err instanceof Error ? err.message : String(err));
      return;
    }
    if (service === null) return;
    const arc22 = new WalletArc22Service(service.wallet, TOKEN_PROGRAM_ID);
    const programAddress = service.getProgramAddress();
    await runAsync(async () => {
      const txId = await arc22.unapprove(programAddress, amountValue);
      setAllowanceNote(`unapprove_public submitted: ${txId}`);
      await arc22.waitForConfirmation(txId);
    });
    await refreshAllowance();
  };

  const onAddManualStream = (e: React.FormEvent) => {
    e.preventDefault();
    setListNote(null);
    if (address === null) return;
    let id: string;
    try {
      id = fieldLiteral(manualStreamId);
    } catch (err) {
      setListNote(err instanceof Error ? err.message : String(err));
      return;
    }
    addKnownStreamId(address, id);
    setManualStreamId("");
    void refreshStreams();
  };

  const onPauseResume = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.pauseResumeStreamPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  const onCancel = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.cancelStreamPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  const onWithdraw = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.withdrawPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  return (
    <>
      <section className="card">
        <h2>Create public stream</h2>
        <form className="grid" onSubmit={onCreate}>
          <label className="field full">
            Receiver address
            <input
              value={receiver}
              onChange={(e) => setReceiver(e.target.value)}
              placeholder="aleo1..."
              disabled={busy}
            />
          </label>
          <label className="field">
            Amount (token units)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            Duration (seconds)
            <input value={duration} onChange={(e) => setDuration(e.target.value)} disabled={busy} />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(e) => setStartNow(e.target.checked)}
              disabled={busy}
            />
            Start now
          </label>
          <label className="field">
            Start time (unix seconds)
            <input
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={busy || startNow}
            />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={isCancelable}
              onChange={(e) => setIsCancelable(e.target.checked)}
              disabled={busy}
            />
            Cancelable
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={isPausable}
              onChange={(e) => setIsPausable(e.target.checked)}
              disabled={busy}
            />
            Pausable
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={autoWithdrawable}
              onChange={(e) => setAutoWithdrawable(e.target.checked)}
              disabled={busy}
            />
            Auto-withdrawable
          </label>
          <label className="field">
            Withdraw frequency (seconds)
            <input
              value={withdrawFrequency}
              onChange={(e) => setWithdrawFrequency(e.target.value)}
              disabled={busy || !autoWithdrawable}
            />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={canTopup}
              onChange={(e) => setCanTopup(e.target.checked)}
              disabled={busy}
            />
            Top-up funding (buffer)
          </label>
          <label className="field">
            Initial buffer amount (token units)
            <input
              value={initialBufferAmount}
              onChange={(e) => setInitialBufferAmount(e.target.value)}
              disabled={busy || !canTopup}
            />
          </label>
          <label className="field full">
            Admin attestation key (signs the TokenPrice; never stored)
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="APrivateKey1..."
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className="field">
            Fee (microcredits)
            <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
          </label>
          <p className="muted full">
            If the token allowance is below the deposit, this submits two wallet transactions:
            <code>approve_public</code> on the token program, then <code>create_stream_public</code>.
          </p>
          {formError !== null && <p className="form-error">{formError}</p>}
          <div className="full">
            <button className="action" type="submit" disabled={busy}>
              {busy ? "Working..." : "Create public stream"}
            </button>
          </div>
        </form>
        {result !== null && <p className="result">{result}</p>}
      </section>

      <section className="card">
        <h2>Token allowance</h2>
        <div className="row-actions" style={{ marginBottom: "0.75rem" }}>
          <button
            className="action secondary"
            onClick={() => void refreshAllowance()}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
        <dl className="kv">
          <dt>Token</dt>
          <dd>{TOKEN_PROGRAM}</dd>
          <dt>Payroll program</dt>
          <dd>{service !== null ? service.getProgramAddress() : "—"}</dd>
          <dt>Allowance</dt>
          <dd>{allowance !== undefined ? allowance.toString() : "?"}</dd>
          <dt>Your {TOKEN_PROGRAM} balance</dt>
          <dd>{tokenBalance !== undefined ? tokenBalance.toString() : "?"}</dd>
        </dl>
        <form className="row-actions" style={{ marginBottom: "0.75rem" }} onSubmit={onApprove}>
          <input
            value={approveAmount}
            onChange={(e) => setApproveAmount(e.target.value)}
            placeholder="amount (token units)"
            disabled={busy}
          />
          <button className="action" type="submit" disabled={busy || approveAmount.trim() === ""}>
            Approve
          </button>
          <button
            className="action danger"
            type="button"
            onClick={(e) => void onUnapprove(e)}
            disabled={busy || approveAmount.trim() === ""}
          >
            Unapprove
          </button>
        </form>
        {allowanceNote !== null && <p className="form-error">{allowanceNote}</p>}
      </section>

      <section className="card">
        <h2>My public streams</h2>
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
            onClick={() => void refreshStreams()}
            disabled={busy}
          >
            Refresh
          </button>
        </form>
        {listNote !== null && <p className="form-error">{listNote}</p>}
        {streams.length === 0 ? (
          <p className="muted">
            No known public streams yet. Create one above, or add a stream id you were given.
          </p>
        ) : (
          <table className="streams">
            <thead>
              <tr>
                <th>Stream id</th>
                <th>Role</th>
                <th>Status</th>
                <th>Withdrawable now</th>
                <th>Withdrawn / Deposited</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <tr key={s.streamId}>
                  <td>{s.streamId}</td>
                  <td>{s.role}</td>
                  <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                  <td>
                    {s.role === "receiver" && s.withdrawable !== undefined
                      ? s.withdrawable.currentlyWithdrawable.toString()
                      : "—"}
                  </td>
                  <td>
                    {s.anchor !== undefined
                      ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                      : "—"}
                  </td>
                  <td>
                    <div className="row-actions">
                      {s.role === "sender" && s.payroll !== undefined && s.anchor !== undefined && (
                        <>
                          <button
                            className="action secondary"
                            onClick={() => void onPauseResume(s.streamId)}
                            disabled={busy || !s.payroll.isPausable || s.anchor.canceled}
                          >
                            {s.anchor.paused ? "Resume" : "Pause"}
                          </button>
                          <button
                            className="action danger"
                            onClick={() => void onCancel(s.streamId)}
                            disabled={busy || !s.payroll.isCancelable || s.anchor.canceled}
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {s.role === "receiver" && (
                        <button
                          className="action"
                          onClick={() => void onWithdraw(s.streamId)}
                          disabled={
                            busy ||
                            s.anchor === undefined ||
                            s.anchor.canceled ||
                            s.withdrawable === undefined ||
                            s.withdrawable.currentlyWithdrawable <= 0n
                          }
                        >
                          Withdraw
                        </button>
                      )}
                      {s.role === "other" && <span className="muted">—</span>}
                    </div>
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
