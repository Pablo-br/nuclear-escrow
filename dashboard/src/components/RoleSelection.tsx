import { useState } from 'react';
import { Building2, Landmark, Shield, ArrowRight, Wallet as WalletIcon } from 'lucide-react';
import { Wallet } from 'xrpl';

export type Role = 'government' | 'company' | null;

interface RoleSelectionProps {
  onLogin: (role: Role, address: string, seed: string) => void;
}

export const RoleSelection: React.FC<RoleSelectionProps> = ({ onLogin }) => {
  const [selectedRole, setSelectedRole] = useState<Role>(null);
  const [wallet, setWallet] = useState('');

  const handleContinue = () => {
    if (selectedRole && wallet.trim().length > 10) {
      try {
        const xrplWallet = Wallet.fromSeed(wallet.trim());
        onLogin(selectedRole, xrplWallet.classicAddress, wallet.trim());
      } catch (err) {
        alert("Clave secreta inválida. Verifique que sea un seed XRPL válido (ej: sEd...).");
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen relative overflow-hidden p-6">
      {/* Background Decor */}
      <div style={{ position: 'absolute', top: '10%', left: '20%', width: '400px', height: '400px', background: 'rgba(14, 165, 233, 0.1)', filter: 'blur(100px)', borderRadius: '50%', zIndex: 0 }}></div>
      <div style={{ position: 'absolute', bottom: '10%', right: '20%', width: '300px', height: '300px', background: 'rgba(139, 92, 246, 0.1)', filter: 'blur(80px)', borderRadius: '50%', zIndex: 0 }}></div>

      <div className="text-center mb-10 z-10 animate-fade-in">
        <div className="flex justify-center mb-6">
          <div className="glass-panel p-4" style={{ borderRadius: '50%' }}>
            <Shield size={48} className="text-info" />
          </div>
        </div>
        <h1 style={{ fontSize: '3rem', marginBottom: '1rem', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>NuclearEscrow</h1>
        <p className="text-lg max-w-xl mx-auto">
          Trustless on-chain escrow for nuclear decommission funds.
        </p>
      </div>

      <div className="glass-panel p-8 max-w-2xl w-full z-10 animate-fade-in" style={{ animationDelay: '0.1s' }}>
        <h2 className="text-center mb-8">¿Quién eres?</h2>

        <div className="grid grid-cols-2 gap-6 mb-8 md:grid-cols-1">
          {/* Government Choice */}
          <div
            className={`glass-card cursor-pointer flex flex-col items-center text-center transition ${selectedRole === 'government' ? 'border-info' : ''}`}
            onClick={() => setSelectedRole('government')}
            style={{
              borderColor: selectedRole === 'government' ? 'var(--accent-blue)' : undefined,
              background: selectedRole === 'government' ? 'rgba(14, 165, 233, 0.1)' : undefined
            }}
          >
            <div className="p-4 rounded-full bg-info mb-4 text-white" style={{ background: 'rgba(14, 165, 233, 0.2)' }}>
              <Landmark size={32} />
            </div>
            <h3 className="font-semibold mb-2">Entidad Gubernamental</h3>
            <p className="text-sm">Supervisar fondos y definir los umbrales de seguridad de liberación.</p>
          </div>

          {/* Company Choice */}
          <div
            className={`glass-card cursor-pointer flex flex-col items-center text-center transition ${selectedRole === 'company' ? 'border-info' : ''}`}
            onClick={() => setSelectedRole('company')}
            style={{
              borderColor: selectedRole === 'company' ? 'var(--accent-purple)' : undefined,
              background: selectedRole === 'company' ? 'rgba(139, 92, 246, 0.1)' : undefined
            }}
          >
            <div className="p-4 rounded-full mb-4 text-white" style={{ background: 'rgba(139, 92, 246, 0.2)', color: 'var(--accent-purple)' }}>
              <Building2 size={32} />
            </div>
            <h3 className="font-semibold mb-2">Empresa Operadora</h3>
            <p className="text-sm">Depositar fondos de escrow y ejecutar hitos de desmantelamiento.</p>
          </div>
        </div>

        {/* Wallet Input */}
        {selectedRole && (
          <div className="animate-fade-in">
            <div className="input-group">
              <label className="input-label flex items-center gap-2">
                <WalletIcon size={16} /> Ingresar Clave Secreta XRPL (Seed)
              </label>
              <input
                type="password"
                className="input-field"
                placeholder="Ej: sEd..."
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                autoFocus
              />
            </div>

            <button
              className="btn btn-primary w-full mt-2"
              onClick={handleContinue}
              disabled={wallet.trim().length <= 10}
              style={{
                background: selectedRole === 'government'
                  ? 'linear-gradient(135deg, var(--accent-blue), #2563eb)'
                  : 'linear-gradient(135deg, var(--accent-purple), #6d28d9)'
              }}
            >
              Continuar al Dashboard <ArrowRight size={18} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
