type TTabsTitle = {
    [key: string]: string | number;
};

type TDashboardTabIndex = {
    [key: string]: number;
};

export const tabs_title: TTabsTitle = Object.freeze({
    WORKSPACE: 'Workspace',
    CHART: 'Chart',
});

export const DBOT_TABS: TDashboardTabIndex = Object.freeze({
    DASHBOARD: 0,
    BOT_BUILDER: 1,
    CHART: 2,
    TUTORIAL: 3,
    // Signal Lab tabs, rendered inside this tab bar and answered by the shell
    // that owns the iframe (Trade history, Settings).
    SIGNAL_LAB_HISTORY: 4,
    SIGNAL_LAB_SETTINGS: 5,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
    'id-charts',
    'id-tutorials',
    'id-signal-lab-history',
    'id-signal-lab-settings',
];

export const DEBOUNCE_INTERVAL_TIME = 500;
