import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { Loader } from '@deriv-com/ui';

const BlocklyLoading = observer(() => {
    const { blockly_store } = useStore();
    const { is_loading, initialization_error } = blockly_store;

    if (!is_loading && !initialization_error) return null;

    return (
        <div className='bot__loading' data-testid={initialization_error ? 'blockly-load-error' : 'blockly-loader'}>
            {initialization_error ? (
                <>
                    <div role='alert'>DBot could not finish loading.</div>
                    <div className='bot__loading-message'>
                        {initialization_error} Reload the workspace to try again.
                    </div>
                    <button type='button' className='dc-btn dc-btn--primary' onClick={() => window.location.reload()}>
                        Reload DBot
                    </button>
                </>
            ) : (
                <>
                    <Loader />
                    <div>Loading Blockly...</div>
                </>
            )}
        </div>
    );
});

export default BlocklyLoading;
