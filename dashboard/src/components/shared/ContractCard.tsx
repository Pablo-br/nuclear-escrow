import React, { useState } from 'react';
import { ShieldAlert, CheckCircle2, XCircle, Clock, Activity, Coins, ArrowUpRight, FileWarning } from 'lucide-react';
import type { Contract } from '../../mock-contracts';

interface ContractCardProps {
  contract: Contract;
  role: 'government' | 'company';
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
}

export const ContractCard: React.FC<ContractCardProps> = ({ contract, role, onAccept, onReject }) => {
  const [showHistory, setShowHistory] = useState(false);

  const formatRLUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount).replace('$', '') + ' RLUSD';
  };

  return (
    <div className="glass-card mb-6">
      <div className="flex justify-between items-start mb-4 flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h3 className="mb-0 text-xl font-bold">{contract.facilityName}</h3>
            {contract.status === 'active' && <span className="badge success"><Activity size={12} className="mr-1"/> Activo</span>}
            {contract.status === 'pending_acceptance' && <span className="badge warning"><Clock size={12} className="mr-1"/> Pendiente</span>}
            {contract.status === 'completed' && <span className="badge neutral"><CheckCircle2 size={12} className="mr-1"/> Completado</span>}
          </div>
          <p className="text-sm font-mono text-muted">ID: {contract.id} • {contract.durationYears} Años</p>
        </div>
        
        <div className="text-right">
          <div className="text-sm text-muted">Fondo Total Acordado</div>
          <div className="text-2xl font-bold text-info">{formatRLUSD(contract.totalAmount)}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6 md:grid-cols-1">
        <div className="p-4 rounded-lg bg-black bg-opacity-20 border border-light">
          <div className="text-xs text-muted mb-1 flex items-center gap-1"><ShieldAlert size={14}/> Fondos Congelados</div>
          <div className="text-lg font-bold">{formatRLUSD(contract.fundsFrozen)}</div>
        </div>
        <div className="p-4 rounded-lg bg-black bg-opacity-20 border border-light">
          <div className="text-xs text-muted mb-1 flex items-center gap-1"><Coins size={14}/> Fondos Recuperados (Empresa)</div>
          <div className="text-lg font-bold text-success">{formatRLUSD(contract.fundsRecovered)}</div>
        </div>
         <div className="p-4 rounded-lg bg-black bg-opacity-20 border border-light">
          <div className="text-xs text-muted mb-1 flex items-center gap-1"><FileWarning size={14}/> Penalizaciones (Gobierno)</div>
          <div className="text-lg font-bold text-danger">{formatRLUSD(contract.fundsPenalized)}</div>
        </div>
      </div>

      <div className="mb-4">
        <div className="text-sm font-semibold mb-2">Fase Actual: {contract.currentPhase} / {contract.conditions.length - 1}</div>
        <div className="w-full bg-black bg-opacity-40 rounded-full h-2.5 mb-1 overflow-hidden border border-light">
          <div className="bg-info h-2.5 rounded-full" style={{ width: `${(contract.currentPhase / Math.max(1, contract.conditions.length - 1)) * 100}%` }}></div>
        </div>
        {contract.conditions[contract.currentPhase] && (
           <div className="text-xs text-muted text-right">Objetivo actual: {contract.conditions[contract.currentPhase].description} (&lt; {contract.conditions[contract.currentPhase].radiationThreshold} mSv)</div>
        )}
      </div>

      {contract.status === 'pending_acceptance' && role === 'company' && (
        <div className="flex gap-4 mt-6 pt-6 border-t border-light">
          <button className="btn btn-primary flex-1" onClick={() => onAccept?.(contract.id)}>
            <CheckCircle2 size={18} /> Aceptar y Depositar Fondos
          </button>
          <button className="btn btn-danger flex-1" onClick={() => onReject?.(contract.id)}>
            <XCircle size={18} /> Rechazar Contrato
          </button>
        </div>
      )}

      {contract.status === 'active' && contract.history.length > 0 && (
        <div className="mt-6 pt-4 border-t border-light">
          <button 
            className="btn btn-secondary w-full justify-between"
            onClick={() => setShowHistory(!showHistory)}
          >
            Ver Historial de Liberación (Ciclos 30 min)
            <ArrowUpRight size={18} style={{ transform: showHistory ? 'rotate(180deg)' : 'none', transition: '0.3s' }} />
          </button>
          
          {showHistory && (
            <div className="mt-4 animate-fade-in overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tiempo</th>
                    <th>Lectura Sensores</th>
                    <th>Estado</th>
                    <th>A Empresa</th>
                    <th>A Gobierno (Penalización)</th>
                  </tr>
                </thead>
                <tbody>
                  {contract.history.map((evt, i) => (
                    <tr key={i}>
                      <td className="font-mono text-sm">{new Date(evt.timestamp).toLocaleTimeString()}</td>
                      <td className="font-mono text-sm">{evt.radiationLevel.toFixed(2)} mSv <span className="text-xs text-muted">/ {evt.threshold}</span></td>
                      <td>
                        {evt.passed 
                          ? <span className="badge success text-xs"><CheckCircle2 size={10} className="mr-1"/> Cumple</span>
                          : <span className="badge danger text-xs"><XCircle size={10} className="mr-1"/> Incumple</span>
                        }
                      </td>
                      <td className="text-success font-mono font-bold">+{formatRLUSD(evt.amountToCompany)}</td>
                      <td className="text-danger font-mono font-bold">{evt.amountToGovernment > 0 ? '+' + formatRLUSD(evt.amountToGovernment) : '0'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
