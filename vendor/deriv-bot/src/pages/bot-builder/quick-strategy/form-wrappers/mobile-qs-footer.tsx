import { useFormikContext } from 'formik';
import { observer } from 'mobx-react-lite';
import Button from '@/components/shared_ui/button';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import useQsSubmitHandler from '../form-wrappers/useQsSubmitHandler';
import { TFormValues } from '../types';
import { QsSteps } from './trade-constants';

type TMobileQSFooter = {
    current_step: QsSteps;
    setCurrentStep: (current_step: QsSteps) => void;
};

export const MobileQSFooter = observer(({ current_step, setCurrentStep }: TMobileQSFooter) => {
    const { quick_strategy } = useStore();
    const { isValid, setFieldValue, validateForm, submitForm } = useFormikContext<TFormValues>();
    const { handleSubmit } = useQsSubmitHandler();
    const is_verified_or_completed_step =
        current_step === QsSteps.StrategyVerified || current_step === QsSteps.StrategyCompleted;
    const is_selected_strategy_step = current_step === QsSteps.StrategySelect;

    const onRun = () => {
        /* [AI] - Analytics removed - rudderstack event call removed */
        /* [/AI] */
        handleSubmit();
    };

    const onLoad = async () => {
        await setFieldValue('action', 'EDIT');
        await validateForm();
        const form_data = await submitForm();
        if (isValid && form_data) quick_strategy.onSubmit({ ...form_data, action: 'EDIT' });
    };

    const onBack = () => {
        setCurrentStep(QsSteps.StrategySelect);
    };

    return (
        <>
            {is_verified_or_completed_step && (
                <div className='qs__mobile-footer'>
                    <Button secondary disabled={is_selected_strategy_step} onClick={onBack}>
                        {localize('Back')}
                    </Button>
                    <Button secondary data-testid='qs-load-button' disabled={!isValid} onClick={onLoad}>
                        {localize('Load')}
                    </Button>
                    <Button
                        primary
                        data-testid='qs-run-button'
                        type='submit'
                        onClick={e => {
                            e.preventDefault();
                            onRun();
                        }}
                        disabled={!isValid || quick_strategy.is_options_loading}
                    >
                        {localize('Run')}
                    </Button>
                </div>
            )}
        </>
    );
});

export default MobileQSFooter;
