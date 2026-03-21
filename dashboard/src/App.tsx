import { useState } from 'react';
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

  const handleLogin = (selectedRole: Role, address: string, seed: string) => {
    setRole(selectedRole);
    setWalletAddress(address);
    setWalletSeed(seed);
  };

  const handleLogout = () => {
    setRole(null);
    setWalletAddress('');
    setWalletSeed('');
  };

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
              <div className="text-sm font-mono text-muted user-wallet">
                {walletAddress.substring(0, 8)}...{walletAddress.substring(walletAddress.length - 4)}
              </div>
              <button className="btn btn-secondary text-sm cursor-pointer" onClick={handleLogout} style={{ padding: '0.4rem 1rem' }}>
                Cerrar Sesión
              </button>
            </div>
          </header>
          
          <main className="main-content">
            {role === 'government' && (
               <GovernmentDashboard walletAddress={walletAddress} />
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
