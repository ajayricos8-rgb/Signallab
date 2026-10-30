// Validate leg-specific settings before sending either buy. A malformed value
// must not silently fall back to another contract's barrier.
export function sanitizeHedgeOptions(contractType, options = {}) {
    const cleaned = {};
    if (contractType === 'TICKHIGH' || contractType === 'TICKLOW') {
        if (options.prediction != null) {
            const tick = Number(options.prediction);
            if (!Number.isInteger(tick) || tick < 1 || tick > 5) {
                throw new Error('High/Low Tick prediction must be an integer from 1 to 5.');
            }
            cleaned.prediction = tick;
        }
        return cleaned;
    }
    if (typeof contractType === 'string' && contractType.startsWith('DIGIT')) {
        if (options.prediction != null) {
            const digit = Number(options.prediction);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
                throw new Error('Digit prediction must be an integer from 0 to 9.');
            }
            cleaned.prediction = digit;
        }
        return cleaned;
    }
    for (const key of ['barrierOffset', 'secondBarrierOffset']) {
        if (options[key] == null) continue;
        const text = String(options[key]).trim();
        // Absolute prices and signed offsets must be plain finite decimals.
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text)) || Number(text) === 0) {
            throw new Error('Invalid hedge barrier. Enter a non-zero price or signed offset supported by this market.');
        }
        cleaned[key] = text;
    }
    return cleaned;
}
