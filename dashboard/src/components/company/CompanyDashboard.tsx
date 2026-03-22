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
    console.log("Accepting using wallet:", walletAddress);

    try {

      const wallet = Wallet.fromSeed(walletSeed);
      const client = new Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();

      const toHex = (str: string) => Array.from(str).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
      const memoData = toHex(`NuclearEscrow-Pact-${id}`);

      console.log("Submitting XRPL record...");
      const tx = await client.submitAndWait({
        TransactionType: 'AccountSet',
        Account: wallet.classicAddress,
        Memos: [{ Memo: { MemoData: memoData } }]
      }, { wallet });

      alert(`✅ Contrato ${id} aceptado y registrado en la blockchain XRPL.\nHash: ${tx.result.hash}\n\nSe abrirá el Explorer para verificarlo.`);
      window.open(`https://testnet.xrpl.org/transactions/${tx.result.hash}`, '_blank');
      
      // Guardar el hash de aceptación en el backend
      await fetch(`/contracts/${id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptanceTxHash: tx.result.hash })
      });
      await client.disconnect();
    } catch (e: any) {
      console.error("XRPL Error:", e);
      alert("⚠️ Contrato aceptado a nivel de sistema. (La escritura XRPL falló localmente, posiblemente la wallet testnet no tenga XRP)");
      await fetch(`/contracts/${id}/accept`, { method: 'POST' });
    }
    
    // Actualizar el estado local
    setContracts(contracts.map(c => 
      c.id === id 
        ? { ...c, status: 'active', fundsFrozen: c.totalAmount } 
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
