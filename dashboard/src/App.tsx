import { useState, useEffect } from 'react';
import { RoleSelection } from './components/RoleSelection.tsx';
import { type Role } from './components/RoleSelection.tsx';
import { GovernmentDashboard } from './components/government/GovernmentDashboard.tsx';
import { CompanyDashboard } from './components/company/CompanyDashboard.tsx';
import { Shield } from 'lucide-react';
import './index.css';

export default function App() {
  const [role, setRole] = useState<Role>(null);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [walletSeed, setWalletSeed] = useState<string>('');
  const [xrpBalance, setXrpBalance] = useState<string>('...');

  const handleLogin = (selectedRole: Role, address: string, seed: string) => {
    setRole(selectedRole);
    setWalletAddress(address);
    setWalletSeed(seed);
  };

  const handleLogout = () => {
    setRole(null);
    setWalletAddress('');
    setWalletSeed('');
    setXrpBalance('...');
  };

  // Fetch real XRPL balance every 10 seconds
  useEffect(() => {
    if (!walletAddress) return;
    const fetchBalance = async () => {
      try {
        const res = await fetch('/xrpl-rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'account_info',
            params: [{ account: walletAddress, ledger_index: 'current' }],
          }),
        });
        const data = await res.json();
        const drops: string = data.result?.account_data?.Balance ?? '0';
        setXrpBalance((parseInt(drops) / 1_000_000).toFixed(4) + ' XRP');
      } catch {
        setXrpBalance('error');
      }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, 10000);
    return () => clearInterval(interval);
  }, [walletAddress]);

  return (
    <div className="app-container">
      {role ? (
        <>
          <header className="app-header">
            <div className="app-logo">
              <Shield className="icon" size={28} />
              <span>NuclearEscrow</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="badge info">
                {role === 'government' ? 'Gobierno' : 'Empresa'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                <div
                  className="text-sm font-mono text-muted user-wallet"
                  style={{ cursor: 'pointer', maxWidth: '340px', wordBreak: 'break-all', fontSize: '0.72rem', lineHeight: 1.3 }}
                  title="Click para copiar tu dirección pública"
                  onClick={() => { navigator.clipboard.writeText(walletAddress); alert(`Dirección copiada: ${walletAddress}`); }}
                >
                  📋 {walletAddress}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontWeight: 600 }}>
                  Balance: {xrpBalance}
                </div>
              </div>
              <button className="btn btn-secondary text-sm cursor-pointer" onClick={handleLogout} style={{ padding: '0.4rem 1rem' }}>
                Cerrar Sesión
              </button>
            </div>
          </header>
          
          <main className="main-content">
            {role === 'government' && (
               <GovernmentDashboard walletAddress={walletAddress} walletSeed={walletSeed} />
            )}
            {role === 'company' && (
               <CompanyDashboard walletAddress={walletAddress} walletSeed={walletSeed} />
            )}
          </main>
        </>
      ) : (
        <RoleSelection onLogin={handleLogin} />
      )}
    </div>
  );
}
