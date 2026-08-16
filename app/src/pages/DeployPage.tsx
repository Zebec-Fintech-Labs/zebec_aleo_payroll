import { useState } from "react";
import programSource from "../../../build/test_zebec_payroll_v4/test_zebec_payroll_v4.aleo?raw";
import { DEFAULT_FEE } from "../config.ts";
import type { UsePayroll } from "../hooks/usePayroll.ts";
import { parseFee } from "./form.ts";

export default function DeployPage({ payroll }: { payroll: UsePayroll }) {
  const { busy, runTx } = payroll;
  const [fee, setFee] = useState(String(DEFAULT_FEE));
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const onDeploy = async () => {
    setFormError(null);
    setResult(null);
    let feeMicro: number;
    try {
      feeMicro = parseFee(fee);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }
    const outcome = await runTx(async (svc) => {
      console.debug("Deploying program:", programSource.slice(0, 100), "...", programSource.length, "bytes");
      const txId = await svc.deploy(programSource, feeMicro);
      setResult(`deployment submitted: ${txId}\nwaiting for confirmation...`);
      await svc.waitForConfirmation(txId);
      return txId;
    });
    if (outcome !== undefined) {
      setResult(`deployment confirmed: ${outcome}`);
    }
  };

  return (
    <section className="card">
      <h2>Deploy / upgrade program</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Deploys <code>build/test_zebec_payroll_v4/test_zebec_payroll_v4.aleo</code> (
        {programSource.length.toLocaleString()} bytes) through the wallet. The same
        call upgrades an existing upgradable deployment of the program.
      </p>
      <form
        className="grid"
        onSubmit={(e) => {
          e.preventDefault();
          void onDeploy();
        }}
      >
        <label className="field">
          Fee (microcredits)
          <input value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
        </label>
        {formError !== null && <p className="form-error">{formError}</p>}
        <div className="full">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Working..." : "Deploy"}
          </button>
        </div>
      </form>
      {result !== null && <p className="result">{result}</p>}
    </section>
  );
}
