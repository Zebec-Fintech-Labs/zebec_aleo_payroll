import { useCallback, useEffect, useState } from "react";
import type { StreamAnchor } from "../../../sdk/types.ts";
import type { WithdrawableAmounts } from "../../../sdk/math.ts";
import type { UseStream } from "../hooks/useStream.ts";

interface IncomingStream {
  streamId: string;
  anchor?: StreamAnchor;
  withdrawable?: WithdrawableAmounts;
  note?: string;
}

function anchorStatus(anchor: StreamAnchor): string {
  if (anchor.canceled) return "canceled";
  if (anchor.paused) return "paused";
  return "active";
}

export default function EmployeePage({ stream }: { stream: UseStream }) {
  const { busy, runTx, service } = stream;
  const [streams, setStreams] = useState<IncomingStream[]>([]);
  const [listNote, setListNote] = useState<string | null>(null);

  const refreshStreams = useCallback(async () => {
    if (service === null) return;
    setListNote(null);
    try {
      const tickets = await service.listMyTickets();
      const receiverTickets = tickets.filter((t) => t.kind === "ReceiverStreamTicket");
      const rows: IncomingStream[] = [];
      for (const ticket of receiverTickets) {
        try {
          const anchor = await service.getStreamAnchor(ticket.streamId);
          let withdrawable: WithdrawableAmounts | undefined;
          try {
            withdrawable = await service.getWithdrawableAmounts(ticket.streamId);
          } catch {
            withdrawable = undefined;
          }
          rows.push({ streamId: ticket.streamId, anchor, ...(withdrawable !== undefined ? { withdrawable } : {}) });
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

  const onWithdraw = async (streamId: string) => {
    await runTx(async (svc) => {
      const txId = await svc.withdraw(streamId);
      await svc.waitForConfirmation(txId);
    });
    await refreshStreams();
  };

  return (
    <section className="card">
      <h2>My incoming streams</h2>
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
        <p className="muted">No receiver tickets found in this wallet.</p>
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
            {streams.map((s) => (
              <tr key={s.streamId}>
                <td>{s.streamId}field</td>
                <td>{s.anchor !== undefined ? anchorStatus(s.anchor) : (s.note ?? "?")}</td>
                <td>{s.withdrawable !== undefined ? s.withdrawable.currentlyWithdrawable.toString() : "—"}</td>
                <td>
                  {s.anchor !== undefined
                    ? `${s.anchor.withdrawnAmount} / ${s.anchor.depositedAmount}`
                    : "—"}
                </td>
                <td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
