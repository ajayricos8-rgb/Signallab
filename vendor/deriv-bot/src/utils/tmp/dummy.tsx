// Legacy icon compatibility module (restored from deriv-com/bot).
//
// Eleven vendored components still import `Icon` from `@/utils/tmp/dummy`, but
// this file was missing from the repository: the vendored app was never
// compiled until the Cloudflare/DBot build chain was added, so the unresolved
// import made every production build fail. The icons themselves live in
// `public/assets/icons/` and are copied into the built `/dbot/` app, so a
// relative image URL resolves correctly there.
import React, { memo, type SyntheticEvent } from 'react';

type TIconComponent = {
    icon: string;
    className?: string;
    onClick?: () => void;
    size?: number | string;
    height?: number | string;
    width?: number | string;
    id?: string;
    color?: string;
    custom_color?: string;
    iconSize?: string;
    style?: React.CSSProperties;
};

const IconComponent: React.FC<TIconComponent> = ({ icon, className, onClick, size, height, width, id, style }) => {
    const onError = (event: SyntheticEvent<HTMLImageElement, Event>) => {
        (event.target as HTMLImageElement).src = 'assets/icons/IcDashboard.svg';
    };

    const dimensions = {
        ...(size !== undefined ? { height: size, width: size } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(width !== undefined ? { width } : {}),
    };

    return (
        <div className={className ? `dummy-icon ${className}` : 'dummy-icon'} onClick={onClick} id={id} style={{ ...dimensions, ...style }}>
            <img src={`assets/icons/${icon}.svg`} alt={icon} onError={onError} />
        </div>
    );
};

export const Icon = memo(IconComponent);

export const IconTradeTypes = ({ children }: { children?: React.ReactNode }) => (
    <div className='dummy-IconTradeTypes'>{children}</div>
);
