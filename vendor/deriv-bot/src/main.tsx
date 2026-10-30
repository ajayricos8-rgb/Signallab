import { configure } from 'mobx';
import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
// Removed AnalyticsInitializer import - analytics dependency removed
// See migrate-docs/ANALYTICS_IMPLEMENTATION_GUIDE.md for re-implementation
import { performVersionCheck } from './utils/version-check';
import { connectSignalLabBridge } from './services/signallab-feed';
import './styles/index.scss';

// Configure MobX to handle multiple instances in production builds
configure({ isolateGlobalState: true });

// Perform version check FIRST - before any other operations
performVersionCheck();
if (window.parent !== window) {
    // Authentication is explicitly granted by the parent per iframe lifetime.
    for (const key of ['active_loginid', 'account_type', 'auth_info', 'deriv_accounts', 'accountsList', 'clientAccounts', 'authToken']) {
        sessionStorage.removeItem(`signal-lab-dbot-${key}`);
    }
}

// The parent (Signal Lab) shares the ticks it already collected and the
// account it is connected to. Register the channel before the workspace loads
// so the first snapshot is not missed.
connectSignalLabBridge();

// Removed AnalyticsInitializer() call - analytics dependency removed

ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);
