type TBrandLogoProps = { width?: number; height?: number; fill?: string; className?: string };
export const BrandLogo = ({ width = 120, height = 32, fill = 'currentColor', className = '' }: TBrandLogoProps) => (
    <svg width={width} height={height} viewBox='0 0 120 32' className={className} role='img' aria-label='Signal Lab'>
        <rect x='0' y='3' width='26' height='26' rx='7' fill='#4c86f7' />
        <path d='M5 17h4l2-6 3 10 2-6h5' stroke='white' strokeWidth='1.8' fill='none' strokeLinecap='round' strokeLinejoin='round' />
        <text x='33' y='20' fontFamily='system-ui, sans-serif' fontSize='11' fontWeight='700' letterSpacing='.35' fill={fill}>SIGNAL LAB</text>
    </svg>
);
