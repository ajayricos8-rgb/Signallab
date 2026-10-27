/**
 * Utility functions for authentication-related operations
 */

/**
 * Clears authentication data from local storage and reloads the page
 */
export const clearAuthData = () => {
    sessionStorage.removeItem('signal-lab-dbot-authToken');
    sessionStorage.removeItem('signal-lab-dbot-active_loginid');
    sessionStorage.removeItem('signal-lab-dbot-client.country');
    sessionStorage.removeItem('signal-lab-dbot-account_type'); // Clear account type when clearing auth data
    sessionStorage.removeItem('signal-lab-dbot-accountsList');
    sessionStorage.removeItem('signal-lab-dbot-clientAccounts');
};
