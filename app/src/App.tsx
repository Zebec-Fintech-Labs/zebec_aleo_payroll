import { useState, type ReactNode } from "react";
import { AleoWalletProvider, useWallet } from "@provablehq/aleo-wallet-adaptor-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@provablehq/aleo-wallet-adaptor-react-ui";
import { DecryptPermission } from "@provablehq/aleo-wallet-adaptor-core";
import { ShieldWalletAdapter } from "@provablehq/aleo-wallet-adaptor-shield";
import { Network } from "@provablehq/aleo-types";

import { CREDITS_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID } from "./config.ts";
import { useStream } from "./hooks/useStream.ts";
import EmployerPage from "./pages/EmployerPage.tsx";
import EmployeePage from "./pages/EmployeePage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import DeployPage from "./pages/DeployPage.tsx";

const wallets = [new ShieldWalletAdapter()];

type Tab = "employer" | "employee" | "admin" | "deploy";

const TABS: { id: Tab; label: string }[] = [
  { id: "employer", label: "Employer" },
  { id: "employee", label: "Employee" },
  { id: "admin", label: "Admin" },
  { id: "deploy", label: "Deploy" },
];

function ConnectGate({ children }: { children: ReactNode }) {
  const { connected } = useWallet();
  if (!connected) {
    return (
      <div className="gate">
        <p>Connect your Shield wallet to continue.</p>
      </div>
    );
  }
  return <>{children}</>;
}

function Shell() {
  const { address, connected } = useWallet();
  const stream = useStream();
  const [tab, setTab] = useState<Tab>("employer");

  return (
    <div className="container">
      <header className="header">
        <div>
          <h1>Zebec Stream</h1>
          <p className="subtitle">
            {PROGRAM_ID} · testnet
            {connected && address !== null && (
              <>
                {" "}· <span className="address">{address}</span>
              </>
            )}
          </p>
        </div>
        <WalletMultiButton />
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {stream.error !== null && (
          <div className="error-banner" onClick={stream.clearError}>
            {stream.error}
          </div>
        )}
        <ConnectGate>
          {tab === "employer" && <EmployerPage stream={stream} />}
          {tab === "employee" && <EmployeePage stream={stream} />}
          {tab === "admin" && <AdminPage stream={stream} />}
          {tab === "deploy" && <DeployPage stream={stream} />}
        </ConnectGate>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AleoWalletProvider
      wallets={wallets}
      network={Network.TESTNET}
      decryptPermission={DecryptPermission.UponRequest}
      programs={[PROGRAM_ID, CREDITS_PROGRAM_ID, TOKEN_PROGRAM_ID, "test_usdcx_multisig_core.aleo", "test_usdcx_freezelist.aleo", "merkle_tree.aleo"]}
      autoConnect={false}
      onError={(error) => console.error(error)}
    >
      <WalletModalProvider>
        <Shell />
      </WalletModalProvider>
    </AleoWalletProvider>
  );
}
