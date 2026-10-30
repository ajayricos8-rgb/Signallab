/** Both independently quoted sides must be present and fresh. A cached or
 * modelled multiple is useful for display, but cannot authorize a purchase. */
export function parityQuotesFresh(table, now = Date.now(), maxAge = 5 * 60 * 1000) {
    return ['even', 'odd'].every(side => {
        const multiple = Number(table?.[side]);
        const at = Number(table?.parityAt?.[side]);
        return Number.isFinite(multiple) && multiple > 1 && Number.isFinite(at) && at > 0 && at <= now && now - at < maxAge;
    });
}
