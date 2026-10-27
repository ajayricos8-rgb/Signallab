import { useEffect } from 'react';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import { ErrorLogger } from '@/utils/error-logger';
import { reloadPage, replaceUrl } from '@/utils/navigation-utils';

/**
 * Hook to handle invalid token events by clearing auth data and redirecting to OAuth login
 *
 * This hook listens for 'InvalidToken' events emitted by the API base when
 * a token is invalid. When such an event is detected, it clears the invalid
 * authentication data and redirects to OAuth login to prevent infinite reload loops.
 *
 * @returns {{ unregisterHandler: () => void }} An object containing a function to unregister the event handler
 */
export const useInvalidTokenHandler = (): { unregisterHandler: () => void } => {
    const handleInvalidToken = async () => {
        try {
            // Clear invalid session data to prevent infinite reload loop
            sessionStorage.removeItem('signal-lab-dbot-auth_info');
            sessionStorage.removeItem('signal-lab-dbot-active_loginid');
            sessionStorage.removeItem('signal-lab-dbot-authToken');
            sessionStorage.removeItem('signal-lab-dbot-accountsList');
            sessionStorage.removeItem('signal-lab-dbot-clientAccounts');

            sessionStorage.removeItem('signal-lab-dbot-deriv_accounts');
            if (window.parent !== window) {
                window.dispatchEvent(new Event('signallab-dbot-socket-closed'));
                const { api_base } = await import('@/external/bot-skeleton');
                api_base.terminate();
                return;
            }

            // Redirect to OAuth login instead of reload to get fresh authentication
            const { generateOAuthURL } = await import('@/components/shared');
            const oauthUrl = await generateOAuthURL();

            if (oauthUrl) {
                // Use replace to prevent back button from returning to invalid state
                replaceUrl(oauthUrl);
            } else {
                // Fallback: reload if OAuth URL generation fails
                ErrorLogger.error('InvalidToken', 'Failed to generate OAuth URL, falling back to reload');
                reloadPage();
            }
        } catch (error) {
            ErrorLogger.error('InvalidToken', 'Error handling invalid token', error);
            // Last resort: reload the page
            reloadPage();
        }
    };

    // Subscribe to the InvalidToken event
    useEffect(() => {
        globalObserver.register('InvalidToken', handleInvalidToken);

        // Cleanup the subscription when the component unmounts
        return () => {
            globalObserver.unregister('InvalidToken', handleInvalidToken);
        };
    }, []);

    // Return a function to unregister the handler manually if needed
    return {
        unregisterHandler: () => {
            globalObserver.unregister('InvalidToken', handleInvalidToken);
        },
    };
};

export default useInvalidTokenHandler;
