import { useState, useEffect } from 'react';
import { ContractCard } from '../shared/ContractCard';
import { Inbox } from 'lucide-react';
import { Client, Wallet } from 'xrpl';

export const CompanyDashboard: React.FC<{ walletAddress: string, walletSeed: string }> = ({ walletAddress, walletSeed }) => {
  const [contracts, setContracts] = useState<any[]>([]);

  useEffect(() => {
    const fetchContracts = () => fetch('/contracts').then(r => r.json()).then(setContracts);
    fetchContracts();
    const interval = setInterval(fetchContracts, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAccept = async (id: string) => {
    const contract = contracts.find(c => c.id === id);
    if (!contract) return;

    console.log("Accepting using wallet:", walletAddress);

    // Scale: use totalAmount directly as drops (1 RLUSD = 1 drop for testnet demo)
    // Cap at 7,000,000 drops (7 XRP) to stay within testnet faucet limits
    const totalDrops = Math.min(contract.totalAmount, 7_000_000);
    const dropsPerPhase = Math.floor(totalDrops / 7);
    const NUM_PHASES = 7;

    let escrowSequences: number[] = [];
    let firstTxHash = '';

    try {
      const wallet = Wallet.fromSeed(walletSeed);
      const client = new Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();

      // Ripple epoch offset
      const rippleNow = Math.floor(Date.now() / 1000) - 946684800;
      const finishAfter = rippleNow + 30; // unlockable after 30 seconds

      console.log(`Creating ${NUM_PHASES} escrows, ${dropsPerPhase} drops each...`);

      for (let phase = 0; phase < NUM_PHASES; phase++) {
        const tx = await client.submitAndWait({
          TransactionType: 'EscrowCreate',
          Account: wallet.classicAddress,
          Amount: String(dropsPerPhase),
          Destination: wallet.classicAddress, // funds return to company on release
          FinishAfter: finishAfter,
        } as any, { wallet });

        const result = tx.result as any;
        const seq: number = result.Sequence ?? result.tx_json?.Sequence ?? result.seq;
        const hash: string = result.hash ?? result.tx_json?.hash ?? '';
        escrowSequences.push(seq);
        if (phase === 0) firstTxHash = hash;
        console.log(`Phase ${phase} escrow created: seq=${seq}, hash=${hash}`);
      }

      await client.disconnect();

      // Persist escrow info + company seed in backend for automated EscrowFinish
      await fetch(`/contracts/${id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acceptanceTxHash: firstTxHash,
          escrowSequences,
          companySeed: walletSeed,
          companyAddress: wallet.classicAddress,
          totalDrops,
          dropsPerPhase,
        }),
      });

      alert(
        `✅ Contrato ${id} aceptado!\n\n` +
        `${totalDrops.toLocaleString()} drops (${(totalDrops / 1_000_000).toFixed(3)} XRP) bloqueados en ${NUM_PHASES} escrows XRPL.\n` +
        `Primer TX: ${firstTxHash}\n\n` +
        `Los fondos se liberarán automáticamente conforme pasen los sensores.`
      );
      if (firstTxHash) window.open(`https://testnet.xrpl.org/transactions/${firstTxHash}`, '_blank');

    } catch (e: any) {
      console.error("XRPL Escrow Error:", e);
      alert("⚠️ Error al crear escrows XRPL: " + e.message + "\n\nVerifica que la wallet tenga suficiente XRP.");
      // fallback: register without escrow sequences
      await fetch(`/contracts/${id}/accept`, { method: 'POST' });
    }

    // Update local state
    setContracts(contracts.map(c =>
      c.id === id
        ? { ...c, status: 'active', fundsFrozen: contract.totalAmount }
        : c
    ));
  };

  const handleReject = (id: string) => {
    setContracts(contracts.filter(c => c.id !== id));
  };

  const pendingContracts = contracts.filter(c => c.status === 'pending_acceptance' && c.companyWallet === walletAddress);
  const activeContracts = contracts.filter(c => c.status !== 'pending_acceptance' && c.companyWallet === walletAddress);

  return (
    <div className="animate-fade-in">
      <div className="mb-8 border-b border-light pb-6">
        <h1 className="mb-2">Portal de Operadoras</h1>
        <p>Gestiona tus depósitos escrow y revisa la liberación progresiva de los fondos on-chain.</p>
      </div>

      <div className="grid grid-cols-[1fr,2fr] gap-8 md:grid-cols-1">

        {/* Sidebar / Pending Contracts */}
        <div className="glass-panel p-6 h-fit sticky top-24">
          <div className="flex items-center gap-2 mb-4 text-warning">
            <Inbox size={20} />
            <h2 className="mb-0 text-lg">Acuerdos Entrantes</h2>
          </div>
          <p className="text-sm text-muted mb-6">El gobierno te ha enviado los siguientes contratos para su fondeo on-chain.</p>

          {pendingContracts.length === 0 ? (
            <div className="p-4 border border-dashed rounded-lg text-center text-sm text-muted">
              No tienes contratos pendientes.
            </div>
          ) : (
            <div className="space-y-4">
              {pendingContracts.map(c => (
                <ContractCard
                  key={c.id}
                  contract={c}
                  role="company"
                  onAccept={handleAccept}
                  onReject={handleReject}
                />
              ))}
            </div>
          )}
        </div>

        {/* Main Area / Active Contracts */}
        <div>
          <h2 className="text-xl mb-4">Mis Proyectos de Desmantelamiento (Activos)</h2>
          {activeContracts.length === 0 ? (
            <div className="text-center p-12 glass-panel border-dashed text-muted">No tienes fondos escrow congelados en xrpl.</div>
          ) : (
            <div className="space-y-6">
              {activeContracts.map(c => (
                <ContractCard key={c.id} contract={c} role="company" />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
