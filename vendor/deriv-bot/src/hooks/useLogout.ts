import { useCallback } from 'react';
import { useStore } from '@/hooks/useStore';
import { ErrorLogger } from '@/utils/error-logger';

/**
 * Custom hook to handle logout functionality
 * Clears all session and local storage to reset the session
 * @returns {Function} handleLogout - Function to trigger the logout process
 */
export const useLogout = () => {
    const { client } = useStore() ?? {};

    return useCallback(async () => {
        try {
            // Call the client store logout method which clears all storage
            await client?.logout();
            // Analytics.reset() removed - Analytics package has been removed from the project
            // See migrate-docs/MONITORING_PACKAGES.md for re-enabling analytics if needed
        } catch (error) {
            ErrorLogger.error('Logout', 'Logout failed', error);
            // If logout fails, clear only auth-related storage keys
            // This preserves user preferences (theme, language, etc.) while ensuring auth data is cleared
            try {
                // Clear auth-related sessionStorage items
                sessionStorage.removeItem('signal-lab-dbot-auth_info');

                // Clear auth-related localStorage items
                sessionStorage.removeItem('signal-lab-dbot-active_loginid');
                sessionStorage.removeItem('signal-lab-dbot-authToken');
                sessionStorage.removeItem('signal-lab-dbot-accountsList');
                sessionStorage.removeItem('signal-lab-dbot-clientAccounts');
                sessionStorage.removeItem('signal-lab-dbot-account_type');
            } catch (storageError) {
                ErrorLogger.error('Logout', 'Failed to clear auth storage', storageError);
                // Do not clear unrelated same-origin application data.
            }
        }
    }, [client]);
};
