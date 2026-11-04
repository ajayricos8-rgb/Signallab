// Demo/Real switch and balance, inside the workspace header.
//
// The account is Signal Lab's: the shell holds the PAT session and pushes one
// account snapshot per second, so this bar is a *view* of that state, never a
// second source of truth. Switching mode asks the shell for an account of that
// type; the shell re-links the workspace and the snapshot follows.
import { useEffect, useState } from 'react';
import { isEmbeddedWorkspace } from '@/services/embed';
import { getSignalLabAccount, subscribeSignalLabBridge } from '@/services/signallab-feed';
import { requestAccountMode } from '@/services/signallab-host';
import './signal-lab-account-bar.scss';

type Snapshot = ReturnType<typeof getSignalLabAccount>;

function formatBalance(balance: number | null, currency: string) {
    if (balance === null || !Number.isFinite(balance)) return '—';
    try {
        return `${currency ? `${currency} ` : ''}${balance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
    } catch {
        return balance.toFixed(2);
    }
}

export function SignalLabAccountBar() {
    const [account, setAccount] = useState<Snapshot>(null);

    useEffect(() => {
        if (!isEmbeddedWorkspace()) return undefined;
        setAccount(getSignalLabAccount());
        return subscribeSignalLabBridge(() => setAccount(getSignalLabAccount()));
    }, []);

    if (!isEmbeddedWorkspace() || !account) return null;

    const mode = account.accountType === 'demo' ? 'demo' : 'real';

    return (
        <div className='sl-account-bar' data-testid='signal-lab-account-bar'>
            <div className='sl-account-bar__toggle' role='group' aria-label='Trading account type'>
                {(['demo', 'real'] as const).map(option_type => (
                    <button
                        key={option_type}
                        type='button'
                        className={`sl-account-bar__option ${mode === option_type ? 'is-active' : ''}`}
                        aria-pressed={mode === option_type}
                        onClick={() => {
                            if (mode === option_type) return;
                            requestAccountMode(option_type);
                        }}
                        data-testid={`signal-lab-mode-${option_type}`}
                    >
                        {option_type === 'demo' ? 'Demo' : 'Real'}
                    </button>
                ))}
            </div>
            <div className='sl-account-bar__balance' data-testid='signal-lab-balance'>
                <span className='sl-account-bar__balance-label'>Balance</span>
                <span className='sl-account-bar__balance-value'>
                    {formatBalance(account.balance, account.currency)}
                </span>
            </div>
        </div>
    );
}

export default SignalLabAccountBar;
