import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@provablehq/aleo-wallet-adaptor-react";
import {
  WalletPayrollService,
  type PayrollWallet,
} from "../payroll/WalletPayrollService.ts";

export interface UsePayroll {
  service: WalletPayrollService | null;
  address: string | null;
  connected: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /**
   * Run an async operation against the service with busy/error handling.
   * Returns the operation result, or `undefined` on error (see `error`).
   */
  runTx: <T>(op: (service: WalletPayrollService) => Promise<T>) => Promise<T | undefined>;
}

/** Build a `WalletPayrollService` from the connected wallet. */
export function usePayroll(): UsePayroll {
  const {
    address,
    connected,
    requestRecords,
    decrypt,
    executeTransaction,
    executeDeployment,
    transactionStatus,
  } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service = useMemo<WalletPayrollService | null>(() => {
    if (!connected || address === null) return null;
    const wallet: PayrollWallet = {
      address,
      requestRecords,
      decrypt,
      executeTransaction,
      executeDeployment,
      transactionStatus,
    };
    return new WalletPayrollService(wallet);
  }, [
    connected,
    address,
    requestRecords,
    decrypt,
    executeTransaction,
    executeDeployment,
    transactionStatus,
  ]);

  const runTx = useCallback(
    async <T,>(op: (service: WalletPayrollService) => Promise<T>): Promise<T | undefined> => {
      if (service === null) {
        setError("wallet is not connected");
        return undefined;
      }
      setBusy(true);
      setError(null);
      try {
        return await op(service);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [service],
  );

  const clearError = useCallback(() => setError(null), []);

  return { service, address, connected, busy, error, clearError, runTx };
}
