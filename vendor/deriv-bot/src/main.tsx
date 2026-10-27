import { configure } from 'mobx';
import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
// Removed AnalyticsInitializer import - analytics dependency removed
// See migrate-docs/ANALYTICS_IMPLEMENTATION_GUIDE.md for re-implementation
import { performVersionCheck } from './utils/version-check';
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

// Removed AnalyticsInitializer() call - analytics dependency removed

ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);
