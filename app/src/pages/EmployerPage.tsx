import { useCallback, useEffect, useState } from "react";
import { computeTopupAmount, nowSeconds } from "../../../sdk/math.ts";
import type { CreateStreamParams, StreamAnchor } from "../../../sdk/types.ts";
import { DEFAULT_FEE } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { loadKnownStreamIds, addKnownStreamId } from "./publicStreamStore.ts";
import { WalletArc22Service } from "../payroll/WalletArc22Service.ts";
import { TOKEN_PROGRAM, TOKEN_PROGRAM_ID } from "../config.ts";
import { fieldLiteral, parseSenderTicket } from "../../../sdk/plaintext.ts";
import { parseBig, parseFee, randomField, requirePrefix } from "./form.ts";

interface OutgoingStream {
  streamId: string;
  anchor?: StreamAnchor;
  /** From the sender ticket: whether the stream was created with top-up enabled. */
  canTopup?: boolean;
  /** From the sender ticket: the stream's full amount (top-up quote base). */
  fullAmount?: bigint;
  note?: string;
}

function anchorStatus(anchor: StreamAnchor): string {
  if (anchor.canceled) return "canceled";
  if (anchor.paused) return "paused";
  return "active";
}

interface KnownStream {
  streamId: string;
  role: "sender" | "receiver" | "other";
  payroll?: any;
  anchor?: StreamAnchor;
  withdrawable?: any;
  note?: string;
}

export default function EmployerPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx, service, address, runAsync } = payroll;

  // Tab view: "private" or "public".
  const [view, setView] = useState<"private" | "public">("private");

  // Create-stream form state (private).
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

  // Known public streams (mirroring PublicStreamPage logic).
  const [knownStreams, setKnownStreams] = useState<KnownStream[]>([]);
  const [publicListNote, setPublicListNote] = useState<string | null>(null);

  // Public stream allowance state.
  const [allowance, setAllowance] = useState<bigint | undefined>(undefined);
  const [tokenBalance, setTokenBalance] = useState<bigint | undefined>(undefined);
  const [approveAmount, setApproveAmount] = useState("0");
  const [allowanceNote, setAllowanceNote] = useState<string | null>(null);
  const [manualStreamId, setManualStreamId] = useState("");

  // Top-up form state (shared by the private and public cards).
  const [topupExtra, setTopupExtra] = useState("0");
  const [topupFee, setTopupFee] = useState(String(DEFAULT_FEE));
  const [selectedPrivateTopup, setSelectedPrivateTopup] = useState("");
  const [selectedPublicTopup, setSelectedPublicTopup] = useState("");
  const [topupError, setTopupError] = useState<string | null>(null);
  const [topupResult, setTopupResult] = useState<string | null>(null);

  const refreshStreams = useCallback(async () => {
    if (service === null) return;
    setListNote(null);
    try {
      const tickets = await service.listMyTickets();
      const senderTickets = tickets.filter((t) => t.kind === "SenderPayrollTicket");
      const rows: OutgoingStream[] = [];
      for (const ticket of senderTickets) {
        let canTopup: boolean | undefined;
        let fullAmount: bigint | undefined;
        try {
          const parsed = parseSenderTicket(ticket.plaintext);
          canTopup = parsed.canTopup;
          fullAmount = parsed.fullAmount;
        } catch {
          // Unparseable ticket — still listed, top-up just stays unavailable.
        }
        try {
          rows.push({
            streamId: ticket.streamId,
            anchor: await service.getStreamAnchor(ticket.streamId),
            ...(canTopup !== undefined ? { canTopup } : {}),
            ...(fullAmount !== undefined ? { fullAmount } : {}),
          });
        } catch {
          rows.push({ streamId: ticket.streamId, note: "no on-chain anchor" });
        }
      }
      setStreams(rows);
    } catch (e) {
      console.error("Refresh streams error:", e);
      setListNote(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  useEffect(() => {
    void refreshStreams();
  }, [refreshStreams]);

  const refreshKnownStreams = useCallback(async () => {
    if (service === null || address === null) return;
    setPublicListNote(null);
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
        let withdrawable: any | undefined;
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
    setKnownStreams(rows);
  }, [service, address]);

  useEffect(() => {
    void refreshKnownStreams();
  }, [refreshKnownStreams]);

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

  const onCreatePrivate = async (e: React.FormEvent) => {
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
      console.error("Create stream error:", err);
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
    setPublicListNote(null);
    if (address === null) return;
    let id: string;
    try {
      id = fieldLiteral(manualStreamId);
    } catch (err) {
      setPublicListNote(err instanceof Error ? err.message : String(err));
      return;
    }
    addKnownStreamId(address, id);
    setManualStreamId("");
    void refreshKnownStreams();
  };

  const onPauseResumePrivate = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.pauseResumeStream(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  const onCancelPrivate = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.cancelStream(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  // ---- Public stream actions ----
  const onCreatePublic = async (e: React.FormEvent) => {
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
      await refreshKnownStreams();
    }
  };

  const onPauseResumePublic = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.pauseResumeStreamPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshKnownStreams();
  };

  const onCancelPublic = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.cancelStreamPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshKnownStreams();
  };

  const onWithdrawPublic = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.withdrawPublic(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshKnownStreams();
  };

  // ---- Top-up (private + public) ----
  const topupablePrivate = streams.filter(
    (s) =>
      s.anchor !== undefined &&
      !s.anchor.canceled &&
      s.anchor.coveredUntil > 0n &&
      s.canTopup === true,
  );
  const topupablePublic = knownStreams.filter(
    (s) =>
      s.role === "sender" &&
      s.payroll !== undefined &&
      s.payroll.canTopup &&
      s.anchor !== undefined &&
      !s.anchor.canceled &&
      s.anchor.coveredUntil > 0n,
  );

  /** Human-readable quote of what the top-up will pull: debt + extra. */
  function topupQuoteText(
    fullAmount: bigint | undefined,
    anchor: StreamAnchor | undefined,
    extra: bigint,
  ): string {
    if (fullAmount === undefined || anchor === undefined || extra < 0n) return "—";
    try {
      const { debtAmount, topupAmount, extraSeconds } = computeTopupAmount(
        anchor,
        fullAmount,
        nowSeconds(),
        extra,
      );
      return (
        `debt ${debtAmount} + extra ${extra} = ${topupAmount} token units` +
        ` (buys ${extraSeconds}s of coverage)`
      );
    } catch {
      return "—";
    }
  }

  const onTopupPrivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setTopupError(null);
    setTopupResult(null);
    let extraValue: bigint;
    let feeMicro: number;
    try {
      if (selectedPrivateTopup === "") throw new Error("select a stream to top up");
      // extra may be 0 when the stream has accrued debt.
      extraValue = parseBig(topupExtra, "extra amount");
      feeMicro = parseFee(topupFee);
    } catch (err) {
      setTopupError(err instanceof Error ? err.message : String(err));
      return;
    }
    const confirmed = await runTx(async (svc) => {
      const txId = await svc.topupStream(selectedPrivateTopup, extraValue, feeMicro);
      setTopupResult(`transaction submitted: ${txId}\nwaiting for confirmation...`);
      await svc.waitForConfirmation(txId);
    });
    if (confirmed !== undefined) {
      setTopupResult(`stream topped up: ${selectedPrivateTopup}`);
      await refreshStreams();
    }
  };

  const onTopupPublic = async (e: React.FormEvent) => {
    e.preventDefault();
    setTopupError(null);
    setTopupResult(null);
    let extraValue: bigint;
    let feeMicro: number;
    try {
      if (selectedPublicTopup === "") throw new Error("select a stream to top up");
      extraValue = parseBig(topupExtra, "extra amount");
      feeMicro = parseFee(topupFee);
    } catch (err) {
      setTopupError(err instanceof Error ? err.message : String(err));
      return;
    }
    const row = topupablePublic.find((s) => s.streamId === selectedPublicTopup);
    if (row?.anchor === undefined || row.payroll === undefined) {
      setTopupError("selected stream is missing on-chain state; refresh and retry");
      return;
    }
    const confirmed = await runTx(async (svc) => {
      // The deposit is pulled from the sender's public balance; approve the
      // program first when the allowance does not cover the top-up amount.
      const arc22 = new WalletArc22Service(svc.wallet, TOKEN_PROGRAM_ID);
      const programAddress = svc.getProgramAddress();
      const { topupAmount } = computeTopupAmount(
        row.anchor!,
        row.payroll!.fullAmount,
        nowSeconds(),
        extraValue,
      );
      if (topupAmount > 0n) {
        const allowanceValue = await arc22.getAllowance(svc.address, programAddress);
        if (allowanceValue < topupAmount) {
          const approveTxId = await arc22.approve(programAddress, topupAmount);
          setTopupResult(`approve_public submitted: ${approveTxId}\nwaiting for confirmation...`);
          await arc22.waitForConfirmation(approveTxId);
        }
      }
      const txId = await svc.topupStreamPublic(selectedPublicTopup, extraValue, feeMicro);
        setTopupResult(`topup_stream_public submitted: ${txId}\nwaiting for confirmation...`);
        await svc.waitForConfirmation(txId);
    });
    if (confirmed !== undefined) {
      setTopupResult(`stream topped up: ${selectedPublicTopup}`);
      await refreshKnownStreams();
    }
  };

  // Tab navigation handlers
  const setPrivateView = () => setView("private");
  const setPublicView = () => setView("public");

  return (
    <>
      {/* Tab switch */}
      <div className="tab-switch" style={{ marginBottom: "1rem", display: "flex", gap: "1rem" }}>
        <button
          className={view === "private" ? "tab active" : "tab"}
          onClick={setPrivateView}
          disabled={busy}
        >
          Private
        </button>
        <button
          className={view === "public" ? "tab active" : "tab"}
          onClick={setPublicView}
          disabled={busy}
        >
          Public
        </button>
      </div>

      {view === "private" && (
        <>
          <section className="card">
            <h2>Create stream</h2>
            <form className="grid" onSubmit={onCreatePrivate}>
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
            Admin attestation key (signs the stream fee; never stored)
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
                          onClick={() => void onPauseResumePrivate(s.streamId)}
                          disabled={busy || s.anchor === undefined || s.anchor.canceled}
                        >
                          {s.anchor?.paused ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="action danger"
                          onClick={() => void onCancelPrivate(s.streamId)}
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

        <TopUpCard
          title="Top up stream"
          busy={busy}
          options={topupablePrivate.map((s) => ({
            streamId: s.streamId,
            label: `${s.streamId}field · covered until ${s.anchor!.coveredUntil}`,
          }))}
          selected={selectedPrivateTopup}
          onSelect={setSelectedPrivateTopup}
          extra={topupExtra}
          onExtraChange={setTopupExtra}
          fee={topupFee}
          onFeeChange={setTopupFee}
          quoteText={topupQuoteText(
            topupablePrivate.find((s) => s.streamId === selectedPrivateTopup)?.fullAmount,
            topupablePrivate.find((s) => s.streamId === selectedPrivateTopup)?.anchor,
            (() => {
              try {
                return parseBig(topupExtra, "extra");
              } catch {
                return -1n;
              }
            })(),
          )}
          error={topupError}
          result={topupResult}
          onSubmit={(e) => void onTopupPrivate(e)}
          emptyHint="No top-up-enabled outgoing streams found in this wallet."
        />
        </>
      )}

      {view === "public" && (
        <>
          <section className="card">
            <h2>Create public stream</h2>
            <form className="grid" onSubmit={onCreatePublic}>
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
                Admin attestation key (signs the stream fee; never stored)
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
            {publicListNote !== null && <p className="form-error">{publicListNote}</p>}
            {knownStreams.length === 0 ? (
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
                  {knownStreams.map((s) => (
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
                                onClick={() => void onPauseResumePublic(s.streamId)}
                                disabled={busy || !s.payroll.isPausable || s.anchor.canceled}
                              >
                                {s.anchor.paused ? "Resume" : "Pause"}
                              </button>
                              <button
                                className="action danger"
                                onClick={() => void onCancelPublic(s.streamId)}
                                disabled={busy || !s.payroll.isCancelable || s.anchor.canceled}
                              >
                                Cancel
                              </button>
                            </>
                          )}
                          {s.role === "receiver" && (
                            <button
                              className="action"
                              onClick={() => void onWithdrawPublic(s.streamId)}
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
        </section>

        <TopUpCard
          title="Top up public stream"
          busy={busy}
          options={topupablePublic.map((s) => ({
            streamId: s.streamId,
            label: `${s.streamId} · covered until ${s.anchor!.coveredUntil}`,
          }))}
          selected={selectedPublicTopup}
          onSelect={setSelectedPublicTopup}
          extra={topupExtra}
          onExtraChange={setTopupExtra}
          fee={topupFee}
          onFeeChange={setTopupFee}
          quoteText={topupQuoteText(
            topupablePublic.find((s) => s.streamId === selectedPublicTopup)?.payroll?.fullAmount,
            topupablePublic.find((s) => s.streamId === selectedPublicTopup)?.anchor,
            (() => {
              try {
                return parseBig(topupExtra, "extra");
              } catch {
                return -1n;
              }
            })(),
          )}
          error={topupError}
          result={topupResult}
          onSubmit={(e) => void onTopupPublic(e)}
          emptyHint="No top-up-enabled public streams found. Create one above, or add a stream id you were given."
        />
        </>
      )}
    </>
  );
}

function TopUpCard({
  title,
  busy,
  options,
  selected,
  onSelect,
  extra,
  onExtraChange,
  fee,
  onFeeChange,
  quoteText,
  error,
  result,
  onSubmit,
  emptyHint,
}: {
  title: string;
  busy: boolean;
  options: { streamId: string; label: string }[];
  selected: string;
  onSelect: (streamId: string) => void;
  extra: string;
  onExtraChange: (value: string) => void;
  fee: string;
  onFeeChange: (value: string) => void;
  quoteText: string;
  error: string | null;
  result: string | null;
  onSubmit: (e: React.FormEvent) => void;
  emptyHint: string;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {options.length === 0 ? (
        <p className="muted">{emptyHint}</p>
      ) : (
        <form className="grid" onSubmit={onSubmit}>
          <label className="field full">
            Stream
            <select
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
              disabled={busy}
            >
              <option value="">— select a stream —</option>
              {options.map((o) => (
                <option key={o.streamId} value={o.streamId}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Extra amount (token units)
            <input
              value={extra}
              onChange={(e) => onExtraChange(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Fee (microcredits)
            <input value={fee} onChange={(e) => onFeeChange(e.target.value)} disabled={busy} />
          </label>
          <p className="muted full">
            Will transfer: {quoteText}
          </p>
          {error !== null && <p className="form-error">{error}</p>}
          <div className="full">
            <button
              className="action"
              type="submit"
              disabled={busy || selected === ""}
            >
              {busy ? "Working..." : "Top up"}
            </button>
          </div>
        </form>
      )}
      {result !== null && <p className="result">{result}</p>}
    </section>
  );
}