import React from 'react';
import {
    getSpeed,
    setSpeed,
    SPEED_PROFILES,
    subscribeSpeed,
    type VisionSpeed,
} from '@/services/vision-speed';
import { localize } from '@deriv-com/translations';
import './speed-control.scss';

const ORDER: VisionSpeed[] = ['slow', 'normal', 'fast'];

const LABELS: Record<VisionSpeed, string> = {
    slow: localize('Slow'),
    normal: localize('Normal'),
    fast: localize('Fast'),
};

const SHORT: Record<VisionSpeed, string> = {
    slow: localize('Slow'),
    normal: localize('Normal'),
    fast: localize('Fast'),
};

/**
 * The Fast/Slow control that sits beside Run.
 *
 * It writes straight to the shared speed service, so the React control, every
 * pause block in a running strategy and the AI's own confirmation logic all
 * read the same value without a store round-trip. The choice is mirrored to the
 * parent Signal Lab frame by the service itself.
 */
const SpeedControl = ({ compact = false }: { compact?: boolean }) => {
    const [speed, setLocalSpeed] = React.useState<VisionSpeed>(getSpeed());

    React.useEffect(() => subscribeSpeed(next => setLocalSpeed(next)), []);

    return (
        <div
            className={`vision-speed${compact ? ' vision-speed--compact' : ''}`}
            role='radiogroup'
            aria-label={localize('Bot speed')}
            data-testid='vision-speed-control'
        >
            <span className='vision-speed__label' aria-hidden='true'>
                {localize('Speed')}
            </span>
            <div className='vision-speed__track' data-speed={speed}>
                {ORDER.map(mode => {
                    const isActive = mode === speed;
                    return (
                        <button
                            key={mode}
                            type='button'
                            role='radio'
                            aria-checked={isActive}
                            title={SPEED_PROFILES[mode].hint}
                            data-testid={`vision-speed-${mode}`}
                            className={`vision-speed__option${isActive ? ' vision-speed__option--active' : ''}`}
                            onClick={() => setSpeed(mode)}
                        >
                            {compact ? SHORT[mode].charAt(0) : SHORT[mode]}
                            <span className='vision-speed__sr'>{LABELS[mode]}</span>
                        </button>
                    );
                })}
                <span className='vision-speed__thumb' aria-hidden='true' />
            </div>
        </div>
    );
};

export default SpeedControl;
