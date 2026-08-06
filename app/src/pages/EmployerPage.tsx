import { useCallback, useEffect, useState } from "react";
import type { CreateStreamParams, StreamAnchor } from "../../../sdk/types.ts";
import { DEFAULT_FEE } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { parseBig, parseFee, randomField, requirePrefix } from "./form.ts";

interface OutgoingStream {
  streamId: string;
  anchor?: StreamAnchor;
  note?: string;
}

function anchorStatus(anchor: StreamAnchor): string {
  if (anchor.canceled) return "canceled";
  if (anchor.paused) return "paused";
  return "active";
}

export default function EmployerPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, service } = payroll;

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

  // Outgoing streams (sender tickets).
  const [streams, setStreams] = useState<OutgoingStream[]>([]);
  const [listNote, setListNote] = useState<string | null>(null);

  const refreshStreams = useCallback(async () => {
    if (service === null) return;
    setListNote(null);
    try {
      const tickets = await service.listMyTickets();
      const senderTickets = tickets.filter((t) => t.kind === "SenderPayrollTicket");
      const rows: OutgoingStream[] = [];
      for (const ticket of senderTickets) {
        try {
          rows.push({
            streamId: ticket.streamId,
            anchor: await service.getStreamAnchor(ticket.streamId),
          });
        } catch {
          rows.push({ streamId: ticket.streamId, note: "no on-chain anchor" });
        }
      }
      setStreams(rows);
    } catch (e) {
      setListNote(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

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
      const txId = await svc.createStreamPrivate(params, adminKey.trim(), feeMicro);
      setResult(`transaction submitted: ${txId}\nwaiting for confirmation...`);
      await svc.waitForConfirmation(txId);
      return svc.getStreamAnchor(params.streamId);
    });
    if (anchor !== undefined) {
      setResult(
        `stream created: ${anchor.streamId}\nstatus: ${anchorStatus(anchor)}` +
          ` · deposited ${anchor.depositedAmount} · duration ${anchor.duration}s`,
      );
      setAdminKey("");
      await refreshStreams();
    }
  };

  const onPauseResume = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.pauseResumeStream(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  const onCancel = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.cancelStream(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  return (
    <>
      <section className="card">
        <h2>Create stream</h2>
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
          {formError !== null && <p className="form-error">{formError}</p>}
          <div className="full">
            <button className="action" type="submit" disabled={busy}>
              {busy ? "Working..." : "Create stream"}
            </button>
          </div>
        </form>
        {result !== null && <p className="result">{result}</p>}
      </section>

      <section className="card">
        <h2>My outgoing streams</h2>
        <div className="row-actions" style={{ marginBottom: "0.75rem" }}>
          <button
            className="action secondary"
            onClick={() => void refreshStreams()}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
        {listNote !== null && <p className="form-error">{listNote}</p>}
        {streams.length === 0 ? (
          <p className="muted">No sender tickets found in this wallet.</p>
        ) : (
          <table className="streams">
            <thead>
              <tr>
                <th>Stream id</th>
                <th>Status</th>
                <th>Withdrawn / Deposited</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <tr key={s.streamId}>
                  <td>{s.streamId}field</td>
                  <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                  <td>
                    {s.anchor !== undefined
                      ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                      : "—"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="action secondary"
                        onClick={() => void onPauseResume(s.streamId)}
                        disabled={busy || s.anchor === undefined || s.anchor.canceled}
                      >
                        {s.anchor?.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        className="action danger"
                        onClick={() => void onCancel(s.streamId)}
                        disabled={busy || s.anchor === undefined || s.anchor.canceled}
                      >
                        Cancel
                      </button>
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
