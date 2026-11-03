// Session brake dialog, shown when a running bot reports take profit / stop
// loss. Rendered into document.body so it sits above the fixed app navigation.
import { createPortal } from 'react-dom';
import { Activity } from 'lucide-react';
import { formatAmount } from '@/lib/deriv-trading';
import type { SessionLimit } from './engine';

export function SessionLimitDialog({ limit, onDismiss }: { limit: SessionLimit; onDismiss: () => void }) {
  const won = limit.reason === 'take-profit';
  return createPortal(
    <div className="ws-dialog-backdrop" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-limit-title"
        aria-describedby="session-limit-profit"
        data-testid="dbot-session-limit-dialog"
        className={`ws-dialog ${won ? 'is-win' : 'is-loss'}`}
      >
        <div className="ws-dialog-icon"><Activity size={29} /></div>
        <p className="ws-dialog-kicker">Session complete</p>
        <h2 id="session-limit-title">{won ? 'Take profit hit' : 'Stop loss hit'}</h2>
        <p className="ws-dialog-label">Total session profit / loss</p>
        <p id="session-limit-profit" className="ws-dialog-amount">
          {limit.profit >= 0 ? '+' : '−'}{formatAmount(Math.abs(limit.profit), limit.currency)}
        </p>
        <p className="ws-dialog-note">The bot has stopped opening new trades. Any other open contracts can still settle.</p>
        <button type="button" autoFocus onClick={onDismiss} className="ws-dialog-button">Dismiss</button>
      </div>
    </div>,
    document.body,
  );
}
