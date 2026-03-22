import { useState, useEffect } from 'react';
import { ContractCard } from '../shared/ContractCard.tsx';
import { PlusCircle, Key } from 'lucide-react';
import { Wallet, Client } from 'xrpl';

export const GovernmentDashboard: React.FC<{ walletAddress: string; walletSeed: string }> = ({ walletAddress, walletSeed }) => {
  const [contracts, setContracts] = useState<any[]>([]);
  
  useEffect(() => {
    const fetchContracts = () => fetch('/contracts').then(r => r.json()).then(setContracts);
    fetchContracts();
    const interval = setInterval(fetchContracts, 5000);
    return () => clearInterval(interval);
  }, []);

  const [showCreateMode, setShowCreateMode] = useState(false);
  const [newContractForm, setNewContractForm] = useState({
    facilityName: '',
    companyWallet: '',
    totalAmount: '',
    durationYears: '50'
  });

  const handleCreateContract = async () => {
    // Si el usuario pega el Seed en vez de la wallet pública, extraemos la dirección automáticamente.
    let finalCompanyWallet = newContractForm.companyWallet.trim();
    try {
      if (finalCompanyWallet.startsWith('s') && finalCompanyWallet.length > 20) {
        finalCompanyWallet = Wallet.fromSeed(finalCompanyWallet).classicAddress;
      }
    } catch(e) { /* ignore - not a valid seed, treat as address */ }

    const contractId = "CTR-NEW-" + Math.floor(Math.random() * 1000);

    const newContract = {
      id: contractId,
      facilityName: newContractForm.facilityName,
      governmentWallet: walletAddress,
      companyWallet: finalCompanyWallet,
      totalAmount: parseInt(newContractForm.totalAmount) || 0,
      durationYears: parseInt(newContractForm.durationYears) || 50,
      status: 'pending_acceptance' as const,
      currentPhase: 0,
      fundsFrozen: 0,
      fundsRecovered: 0,
      fundsPenalized: 0,
      conditions: [
        { phase: 0, description: "Defueling complete", radiationThreshold: 100 },
        { phase: 1, description: "Site restored", radiationThreshold: 0.01 }
      ],
      history: [],
      proposalTxHash: '',
      acceptanceTxHash: '',
    };
    // 2. Registrar la propuesta en la blockchain XRPL
    let txHash = '(no registrado)';
    try {
      const wallet = Wallet.fromSeed(walletSeed);
      const client = new Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();

      const toHex = (str: string) => Array.from(str).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join('').toUpperCase();
      const memoData = toHex(JSON.stringify({
        type: 'NuclearEscrow-Proposal',
        contractId,
        facility: newContractForm.facilityName,
        companyWallet: finalCompanyWallet,
        amount: newContractForm.totalAmount,
      }));

      const tx = await client.submitAndWait({
        TransactionType: 'AccountSet',
        Account: wallet.classicAddress,
        Memos: [{ Memo: { MemoData: memoData } }]
      }, { wallet });

      txHash = tx.result.hash;
      newContract.proposalTxHash = txHash;
      await client.disconnect();
    } catch (e: any) {
      console.error('XRPL Proposal Error:', e);
    }

    // 3. Guardar en el backend (con el hash incluido)
    await fetch('/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newContract)
    });

    if (txHash !== '(no registrado)') {
      const explorerUrl = `https://testnet.xrpl.org/transactions/${txHash}`;
      alert(
        `✅ Contrato ${contractId} creado y registrado en la blockchain XRPL.\n\n` +
        `Wallet empresa: ${finalCompanyWallet}\n` +
        `Hash: ${txHash}\n\n` +
        `Se abrirá el Explorer para que lo verifiques.`
      );
      window.open(explorerUrl, '_blank');
    } else {
      alert(
        `⚠️ Contrato ${contractId} creado localmente, pero NO se registró en la blockchain.\n` +
        `Posiblemente la wallet testnet no tiene XRP suficientes.`
      );
    }
    
    setContracts([...contracts, newContract]);
    setShowCreateMode(false);
    setNewContractForm({ facilityName: '', companyWallet: '', totalAmount: '', durationYears: '50' });
  };

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="mb-2">Centro de Control Gubernamental</h1>
          <p>Supervisa el estado de los fondos escrow y gestiona contratos con operadoras.</p>
        </div>
        {!showCreateMode && (
          <button className="btn btn-primary" onClick={() => setShowCreateMode(true)}>
            <PlusCircle size={18} /> Crear Nuevo Contrato
          </button>
        )}
      </div>

      {showCreateMode ? (
        <div className="glass-card mb-8 animate-fade-in">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-full bg-info bg-opacity-20 text-info">
              <Key size={24} />
            </div>
            <h2 className="mb-0">Emitir Nuevo Contrato Escrow</h2>
          </div>
          
          <div className="grid grid-cols-2 gap-6 md:grid-cols-1">
            <div className="input-group">
              <label className="input-label">Identificador de Instalación</label>
              <input 
                type="text" 
                className="input-field" 
                placeholder="Ej: PLANT-FR-001" 
                value={newContractForm.facilityName}
                onChange={e => setNewContractForm({...newContractForm, facilityName: e.target.value})}
              />
            </div>
            <div className="input-group">
              <label className="input-label">Wallet Pública de la Empresa Operadora (o su Seed)</label>
              <input 
                type="text" 
                className="input-field" 
                placeholder="rEmpresa... ó sEd... (se auto-deriva la dirección)" 
                value={newContractForm.companyWallet}
                onChange={e => setNewContractForm({...newContractForm, companyWallet: e.target.value})}
              />
              {newContractForm.companyWallet.trim().startsWith('s') && newContractForm.companyWallet.trim().length > 20 && (() => {
                try {
                  const derived = Wallet.fromSeed(newContractForm.companyWallet.trim()).classicAddress;
                  return <p className="text-xs text-success mt-2">✓ Dirección pública derivada: {derived}</p>;
                } catch {
                  return <p className="text-xs text-danger mt-2">✗ Seed inválido</p>;
                }
              })()}
            </div>
             <div className="input-group">
              <label className="input-label">Monto Total (RLUSD)</label>
              <input 
                type="number" 
                className="input-field" 
                placeholder="10000000" 
                value={newContractForm.totalAmount}
                onChange={e => setNewContractForm({...newContractForm, totalAmount: e.target.value})}
              />
            </div>
             <div className="input-group">
              <label className="input-label">Duración Total (Años)</label>
              <input 
                type="number" 
                className="input-field" 
                placeholder="50" 
                value={newContractForm.durationYears}
                onChange={e => setNewContractForm({...newContractForm, durationYears: e.target.value})}
              />
            </div>
          </div>
          
          <div className="mt-4 p-4 rounded-lg bg-black bg-opacity-20 border border-light mb-6">
            <p className="text-sm text-muted mb-2">Nota: Se usarán las 7 fases estándar de desmantelamiento con los umbrales predeterminados. La liberación ocurrirá en ciclos de 1 minuto una vez que la empresa acepte y fondee el smart contract.</p>
            <p className="text-xs text-warning mt-2">⚠️ Testnet: El monto se bloquea como XRP drops reales en XRPL (1 RLUSD = 1 drop). Máximo efectivo: 7,000,000 drops (7 XRP). El cron libera cada fase automáticamente via EscrowFinish on-chain.</p>
          </div>

          <div className="flex justify-end gap-4 border-t border-light pt-6">
             <button className="btn btn-secondary" onClick={() => setShowCreateMode(false)}>Cancelar</button>
             <button className="btn btn-primary" onClick={handleCreateContract}>Enviar a la Empresa</button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <h2 className="text-xl mb-4">Contratos Abiertos</h2>
          {contracts.filter(c => c.governmentWallet === walletAddress).length === 0 ? (
            <div className="text-center p-12 glass-panel border-dashed text-muted">No hay contratos activos.</div>
          ) : (
            contracts.filter(c => c.governmentWallet === walletAddress).map(c => <ContractCard key={c.id} contract={c} role="government" />)
          )}
        </div>
      )}
    </div>
  );
};
