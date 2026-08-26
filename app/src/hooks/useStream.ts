import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@provablehq/aleo-wallet-adaptor-react";
import {
  WalletStreamService,
  type StreamWallet,
} from "../stream/WalletStreamService.ts";

export interface UseStream {
  service: WalletStreamService | null;
  address: string | null;
  connected: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /**
   * Run an async operation against the service with busy/error handling.
   * Returns the operation result, or `undefined` on error (see `error`).
   */
  runTx: <T>(op: (service: WalletStreamService) => Promise<T>) => Promise<T | undefined>;
  /**
   * Run any async operation (e.g. the token `WalletArc22Service` methods,
   * which are not `WalletStreamService` methods) with the same busy/error
   * handling. Returns the operation result, or `undefined` on error.
   */
  runAsync: <T>(op: () => Promise<T>) => Promise<T | undefined>;
}

/** Build a `WalletStreamService` from the connected wallet. */
export function useStream(): UseStream {
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

  const service = useMemo<WalletStreamService | null>(() => {
    if (!connected || address === null) return null;
    const wallet: StreamWallet = {
      address,
      requestRecords,
      decrypt,
      executeTransaction,
      executeDeployment,
      transactionStatus,
    };
    return new WalletStreamService(wallet);
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
    async <T,>(op: (service: WalletStreamService) => Promise<T>): Promise<T | undefined> => {
      if (service === null) {
        setError("wallet is not connected");
        return undefined;
      }
      setBusy(true);
      setError(null);
      try {
        return await op(service);
      } catch (e) {
        console.error("Error runing tx:", e);
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [service],
  );

  const runAsync = useCallback(
    async <T,>(op: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await op();
      } catch (e) {
        console.error("Error running op:", e);
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { service, address, connected, busy, error, clearError, runTx, runAsync };
}
