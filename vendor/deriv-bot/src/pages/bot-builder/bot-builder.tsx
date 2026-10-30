import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { botNotification } from '@/components/bot-notification/bot-notification';
import { notification_message } from '@/components/bot-notification/bot-notification-utils';
import { useStore } from '@/hooks/useStore';
import { api_base, load } from '@/external/bot-skeleton';
import { clearDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { getSpeed, setSpeed } from '@/services/vision-speed';
import { setSignalLabAnalysisSnapshot } from '@/services/signallab-feed';
import { getSignalLabGrantId, getSignalLabSessionRevision, hasSignalLabAccount, linkSignalLabAccount, receiveSignalLabSocket, unlinkSignalLabAccount } from '@/services/signallab-session';
import { localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import { TBlocklyEvents } from 'Types';
import LoadModal from '../../components/load-modal';
import SaveModal from '../dashboard/bot-list/save-modal';
import BotBuilderTourHandler from '../tutorials/dbot-tours/bot-builder-tour';
import QuickStrategy1 from './quick-strategy';
import WorkspaceWrapper from './workspace-wrapper';

function getWorkspaceBlockRegistry() {
    const entries = Object.entries(window.Blockly?.Blocks ?? {});
    const requiredAiBlocks = ['vision_analyse', 'vision_go', 'signal_lab_analysis_gate'];
    // Keep every Signal Lab/Vision block in the snapshot even if Deriv adds
    // enough standard blocks to push those definitions past the cap.
    const preferred = entries.filter(([type]) =>
        type.startsWith('vision_') || type.startsWith('x_ai_') || type.startsWith('signal_lab_'),
    );
    const preferredTypes = new Set(preferred.map(([type]) => type));
    const orderedEntries = [...preferred, ...entries.filter(([type]) => !preferredTypes.has(type))].slice(0, 800);
    const blocks = orderedEntries.map(([type, block]) => {
        let meta: Record<string, unknown> = {};
        let definition: Record<string, unknown> = {};
        try {
            meta = typeof block?.meta === 'function' ? block.meta() ?? {} : {};
        } catch {
            meta = {};
        }
        try {
            definition = typeof block?.definition === 'function' ? block.definition() ?? {} : {};
        } catch {
            definition = {};
        }
        const name = typeof meta.display_name === 'string' ? meta.display_name : type;
        const description = typeof meta.description === 'string' ? meta.description.slice(0, 360) : '';
        const rawCategory = meta.category ?? definition.category;
        const category = typeof rawCategory === 'string'
            ? rawCategory
            : type.startsWith('vision_') || type.startsWith('x_') ? 'Vision Lab'
                : type.startsWith('signal_lab_') ? 'Signal Lab' : 'DBot';
        return { type, name, category, description };
    });
    const generator = window.Blockly?.JavaScript?.javascriptGenerator?.forBlock ?? {};
    const hasAiRuntime = (type: string) => Boolean(window.Blockly?.Blocks?.[type] && generator[type]);
    return {
        count: entries.length,
        blocks,
        aiRuntimeRegistered: requiredAiBlocks.every(hasAiRuntime),
    };
}

const BotBuilder = observer(() => {
    const { dashboard, app, client, run_panel, toolbar, quick_strategy, blockly_store } = useStore();
    const { active_tab, active_tour, is_preview_on_popup } = dashboard;
    const { is_open } = quick_strategy;
    const { is_running } = run_panel;
    const { is_loading, initialization_error } = blockly_store;
    const is_blockly_listener_registered = React.useRef(false);
    const is_blockly_delete_listener_registered = React.useRef(false);
    const { isDesktop } = useDevice();
    const { onMount, onUnmount } = app;
    const el_ref = React.useRef<HTMLInputElement | null>(null);

    // Narrow same-origin bridge for Signal Lab's navigation and curated store.
    // It deliberately exposes no tokens, order methods, or arbitrary XML.
    React.useEffect(() => {
        if (is_loading || initialization_error || !window.Blockly?.derivWorkspace || window.parent === window) return;
        const notify = (type: string, detail: Record<string, unknown> = {}) =>
            window.parent.postMessage({ source: 'signal-lab-dbot', type, ...detail }, window.location.origin);
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== window.parent) return;
            const data = event.data;
            if (!data || data.source !== 'signal-lab' || typeof data.type !== 'string') return;
            if (data.type === 'hello') {
                notify('ready');
                notify('block-registry', getWorkspaceBlockRegistry());
            }
            // The host mirrors the Fast/Slow control; keep the two in step.
            if (data.type === 'set-speed' && (data.speed === 'slow' || data.speed === 'normal' || data.speed === 'fast')) {
                setSpeed(data.speed, { silent: true });
            }
            if (data.type === 'request-speed') notify('speed', { speed: getSpeed() });
            if (data.type === 'clear-analysis') {
                setSignalLabAnalysisSnapshot(null);
            }
            if (data.type === 'load-bot') {
                if (run_panel.is_running) {
                    notify('error', { message: 'Stop your running bot before loading another strategy.' });
                    return;
                }
                if (typeof data.xml !== 'string' || !data.xml.trim()) {
                    notify('error', { message: 'That strategy could not be read.' });
                    return;
                }
                const runAfterLoad = data.runAfterLoad === true;
                if (runAfterLoad && (!hasSignalLabAccount() || !client.is_logged_in)) {
                    notify('error', { message: 'Connect the Signal Lab account in DBot before starting this strategy.' });
                    return;
                }
                const workspace = window.Blockly?.derivWorkspace;
                if (!workspace) {
                    notify('error', { message: 'The workspace is still loading. Try again in a moment.' });
                    return;
                }
                const raw_name = typeof data.name === 'string' ? data.name : typeof data.fileName === 'string' ? data.fileName : '';
                const name = raw_name.trim() || 'Vision Lab bot';
                const has_blocks = workspace.getAllBlocks(false).length > 0;
                if (has_blocks && !window.confirm(`Replace the strategy in the workspace with “${name}”? Unsaved changes will be lost.`)) {
                    return;
                }
                setSignalLabAnalysisSnapshot(null);
                dashboard.setActiveTab(1);
                window.setTimeout(() => {
                    Promise.resolve(
                        load({
                            block_string: data.xml as string,
                            file_name: name,
                            workspace,
                            from: 'signal-lab',
                            showIncompatibleStrategyDialog: () => Promise.resolve(true),
                        } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
                    )
                        .then(async (result: unknown) => {
                            const error = (result as { error?: string } | undefined)?.error;
                            if (error) {
                                notify('error', { message: error });
                                return;
                            }
                            if (runAfterLoad && !setSignalLabAnalysisSnapshot(data.analysisSnapshot)) {
                                notify('error', { message: 'The analysis snapshot is missing or invalid. Run a fresh analysis and load the strategy again.' });
                                return;
                            }
                            notify('bot-loaded', { name, runAfterLoad });
                            window.dispatchEvent(new Event('resize'));
                            if (runAfterLoad) {
                                if (!hasSignalLabAccount() || !client.is_logged_in) {
                                    setSignalLabAnalysisSnapshot(null);
                                    notify('error', { message: 'The Signal Lab account disconnected before DBot could start.' });
                                    return;
                                }
                                try {
                                    await run_panel.onRunButtonClick();
                                    if (!run_panel.is_running) throw new Error('DBot did not enter the running state.');
                                    notify('bot-run-started', { name });
                                } catch (cause) {
                                    setSignalLabAnalysisSnapshot(null);
                                    notify('error', { message: cause instanceof Error ? cause.message : 'DBot could not start the strategy.' });
                                }
                            }
                        })
                        .catch(() => notify('error', { message: `“${name}” could not be loaded into the workspace.` }));
                }, 60);
            }
            if (data.type === 'otp-response') {
                receiveSignalLabSocket(data.requestId, data.accountId, data.url, data.error);
            }
            if (data.type === 'connect-account') {
                if (run_panel.is_running) { notify('account-error', { grantId: data.grantId, message: 'Stop the running bot before changing accounts.' }); return; }
                if (typeof data.accountId !== 'string' || !linkSignalLabAccount(data.accountId, data.url, data.grantId)) {
                    notify('account-error', { grantId: data.grantId, message: 'The DBot account connection was invalid.' }); return;
                }
                sessionStorage.setItem('signal-lab-dbot-active_loginid', data.accountId);
                sessionStorage.setItem('signal-lab-dbot-account_type', data.accountType === 'real' ? 'real' : 'demo');
                const revision = getSignalLabSessionRevision();
                clearDerivApiInstance();
                api_base.init(true).catch(() => {
                    if (revision !== getSignalLabSessionRevision()) return;
                    unlinkSignalLabAccount();
                    client.setIsLoggedIn(false);
                    sessionStorage.removeItem('signal-lab-dbot-active_loginid');
                    sessionStorage.removeItem('signal-lab-dbot-account_type');
                    clearDerivApiInstance();
                    api_base.init(true).catch(() => undefined);
                    notify('account-error', { grantId: data.grantId, message: 'Could not connect DBot to this account.' });
                });
            }
            if (data.type === 'disconnect-account') {
                if (data.grantId !== getSignalLabGrantId()) return;
                run_panel.stopForAccountDisconnect();
                unlinkSignalLabAccount();
                client.setIsLoggedIn(false);
                sessionStorage.removeItem('signal-lab-dbot-active_loginid');
                sessionStorage.removeItem('signal-lab-dbot-account_type');
                clearDerivApiInstance();
                api_base.init(true).catch(() => undefined);
                notify('account-disconnected', { grantId: data.grantId });
            }
            if (data.type === 'navigate' && (data.tab === 'builder' || data.tab === 'chart')) {
                if (data.tab === 'chart' && quick_strategy.is_open) {
                    if (!window.confirm('Close Quick strategy to open charts? Unsaved form changes will be lost.')) {
                        notify('active-tab', { tab: 1 });
                        notify('quick-strategy-open');
                        return;
                    }
                    quick_strategy.setFormVisibility(false);
                }
                dashboard.setActiveTab(data.tab === 'chart' ? 2 : 1);
                window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
            }
            if (data.type === 'quick-strategy') {
                const allowed = ['MARTINGALE', 'D_ALEMBERT', 'OSCARS_GRIND', 'REVERSE_MARTINGALE', 'REVERSE_D_ALEMBERT', 'STRATEGY_1_3_2_6'];
                if (!allowed.includes(data.strategy)) return;
                if (run_panel.is_running) {
                    notify('error', { message: 'Stop your running bot before opening another strategy.' });
                    return;
                }
                if (quick_strategy.is_open && !window.confirm('Replace the open Quick strategy form? Unsaved form changes will be lost.')) return;
                if (quick_strategy.is_open) quick_strategy.setFormVisibility(false);
                dashboard.setActiveTab(1);
                quick_strategy.openPresetStrategy(data.strategy);
                window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
            }
        };
        const onSocketClosed = () => {
            if (!hasSignalLabAccount()) return;
            const grantId = getSignalLabGrantId();
            run_panel.stopForAccountDisconnect();
            unlinkSignalLabAccount();
            client.setIsLoggedIn(false);
            sessionStorage.removeItem('signal-lab-dbot-active_loginid');
            sessionStorage.removeItem('signal-lab-dbot-account_type');
            notify('account-disconnected', { grantId, reason: 'connection-lost' });
        };
        window.addEventListener('message', onMessage);
        window.addEventListener('signallab-dbot-socket-closed', onSocketClosed);
        notify('ready');
        notify('block-registry', getWorkspaceBlockRegistry());
        return () => {
            window.removeEventListener('message', onMessage);
            window.removeEventListener('signallab-dbot-socket-closed', onSocketClosed);
        };
    }, [is_loading, initialization_error, dashboard, quick_strategy, run_panel, client]);

    React.useEffect(() => {
        if (window.parent !== window && is_open) {
            window.parent.postMessage({ source: 'signal-lab-dbot', type: 'quick-strategy-open' }, window.location.origin);
        }
    }, [is_open]);

    React.useEffect(() => {
        if (window.parent !== window && hasSignalLabAccount() && client.is_logged_in) {
            window.parent.postMessage({ source: 'signal-lab-dbot', type: 'account-connected', accountId: client.loginid, grantId: getSignalLabGrantId() }, window.location.origin);
        }
    }, [client.is_logged_in, client.loginid]);

    React.useEffect(() => {
        if (window.parent !== window) {
            window.parent.postMessage({ source: 'signal-lab-dbot', type: 'bot-status', running: is_running }, window.location.origin);
        }
    }, [is_running]);

    React.useEffect(() => {
        if (window.parent !== window) {
            window.parent.postMessage({ source: 'signal-lab-dbot', type: 'active-tab', tab: active_tab }, window.location.origin);
        }
    }, [active_tab]);

    // TODO: fix
    // const isMounted = useIsMounted();
    // const { data: remote_config_data } = useRemoteConfig(isMounted());
    let deleted_block_id: null | string = null;

    React.useEffect(() => {
        onMount();
        return () => onUnmount();
    }, [onMount, onUnmount]);

    React.useEffect(() => {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace && is_running && !is_blockly_listener_registered.current) {
            is_blockly_listener_registered.current = true;
            workspace.addChangeListener(handleBlockChangeOnBotRun);
        } else {
            removeBlockChangeListener();
        }

        return () => {
            if (workspace && is_blockly_listener_registered.current) {
                removeBlockChangeListener();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_running]);

    const handleBlockChangeOnBotRun = (e: Event) => {
        const { is_reset_button_clicked } = toolbar;
        if (e.type !== 'selected' && !is_reset_button_clicked) {
            botNotification(notification_message().workspace_change);
            removeBlockChangeListener();
        } else if (is_reset_button_clicked) {
            removeBlockChangeListener();
        }
    };

    const removeBlockChangeListener = () => {
        is_blockly_listener_registered.current = false;
        window.Blockly?.derivWorkspace?.removeChangeListener(handleBlockChangeOnBotRun);
    };
    React.useEffect(() => {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace && !is_blockly_delete_listener_registered.current) {
            is_blockly_delete_listener_registered.current = true;
            workspace.addChangeListener(handleBlockDelete);
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_loading]);

    const handleBlockDelete = (e: TBlocklyEvents) => {
        const { is_reset_button_clicked, setResetButtonState } = toolbar;
        if (e.type === 'undo') {
            deleted_block_id = null;
            return;
        }
        if (e.type === 'delete' && !is_reset_button_clicked) {
            deleted_block_id = e.blockId;
        }
        if (e.type === 'selected' && deleted_block_id === e.oldElementId) {
            handleBlockDeleteNotification();
            deleted_block_id = null;
        }
        if (
            e.type === 'change' &&
            e.name === 'AMOUNT_LIMITS' &&
            e.newValue === '(min: 0.35 - max: 50000)' &&
            is_reset_button_clicked
        ) {
            setResetButtonState(false);
        }
    };

    const handleBlockDeleteNotification = () => {
        botNotification(notification_message().block_delete, {
            label: localize('Undo'),
            onClick: closeToast => {
                window.Blockly.derivWorkspace.undo();
                closeToast?.();
            },
        });
    };

    return (
        <>
            <div
                className={classNames('bot-builder', {
                    'bot-builder--active': active_tab === 1 && !is_preview_on_popup,
                    'bot-builder--inactive': is_preview_on_popup,
                    'bot-builder--tour-active': active_tour,
                })}
            >
                <div id='scratch_div' ref={el_ref}>
                    <WorkspaceWrapper />
                </div>
            </div>
            {active_tab === 1 && window.parent === window && <BotBuilderTourHandler is_mobile={!isDesktop} />}
            {/* removed this outside from toolbar becuase it needs to loaded seperately without dependency */}
            <LoadModal />
            <SaveModal />
            {is_open && <QuickStrategy1 key={quick_strategy.preset_revision} />}
        </>
    );
});

export default BotBuilder;
