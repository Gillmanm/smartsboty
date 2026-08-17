export type TickDirection = 'up' | 'down' | 'flat';
export type AnalyzerSignalDirection = 'CALL' | 'PUT';

export type AnalyzerTick = {
    quote: number;
    epoch: number;
};

export type AnalyzerSignal = {
    symbol: string;
    direction: AnalyzerSignalDirection;
    directionLabel: 'Only ups' | 'Only downs';
    triggerDirection: Exclude<TickDirection, 'flat'>;
    runLength: number;
    durationTicks: 2;
    triggerEpoch: number;
    signalId: string;
};

export type AnalyzerSettings = {
    selectedSymbols: string[];
    allMarkets: boolean;
    minimumRun: number;
    predictionTicks: 2;
    stake: number;
    currency: string;
    entryMode: 'manual' | 'automatic';
    accountId: string;
    maxConcurrentEntries: number;
};

export const DEFAULT_ANALYZER_SETTINGS: AnalyzerSettings = {
    selectedSymbols: [],
    allMarkets: true,
    minimumRun: 4,
    predictionTicks: 2,
    stake: 1,
    currency: 'USD',
    entryMode: 'manual',
    accountId: '',
    maxConcurrentEntries: 1,
};

export const getTickDirection = (previous: number | undefined, current: number): TickDirection => {
    if (previous === undefined || current === previous) return 'flat';
    return current > previous ? 'up' : 'down';
};

export const getOppositeContract = (triggerDirection: Exclude<TickDirection, 'flat'>): AnalyzerSignalDirection =>
    triggerDirection === 'up' ? 'PUT' : 'CALL';

/**
 * Returns the most recent movement steps for a compact rise/fall trail.
 * Four markers represent four quote-to-quote movements, not four raw quotes.
 * The first marker therefore uses the quote immediately before the visible
 * window whenever that quote exists.
 */
export const getMovementTrail = (ticks: AnalyzerTick[], size = 4): TickDirection[] => {
    if (ticks.length < 2 || size < 1) return [];

    const movements: TickDirection[] = [];
    for (let index = 1; index < ticks.length; index += 1) {
        movements.push(getTickDirection(ticks[index - 1].quote, ticks[index].quote));
    }

    return movements.slice(-size);
};

/**
 * Returns one signal when the latest tick completes a run of the configured
 * minimum length. Flat ticks reset the run because the market did not move.
 * A completed run is one-shot: callers should not call this again for the
 * same epoch.
 */
export const detectReversalSignal = (
    symbol: string,
    ticks: AnalyzerTick[],
    minimumRun = 4
): AnalyzerSignal | null => {
    if (ticks.length < 2 || minimumRun < 2) return null;

    let direction: Exclude<TickDirection, 'flat'> | null = null;
    let runLength = 0;
    let previousQuote: number | undefined;

    for (const tick of ticks) {
        const tickDirection = getTickDirection(previousQuote, tick.quote);
        previousQuote = tick.quote;

        if (tickDirection === 'flat') {
            direction = null;
            runLength = 0;
            continue;
        }

        if (direction === tickDirection) {
            runLength += 1;
        } else {
            direction = tickDirection;
            runLength = 1;
        }
    }

    if (!direction || runLength < minimumRun) return null;

    const latest = ticks[ticks.length - 1];
    const oppositeContract = getOppositeContract(direction);

    return {
        symbol,
        direction: oppositeContract,
        directionLabel: direction === 'up' ? 'Only ups' : 'Only downs',
        triggerDirection: direction,
        runLength,
        durationTicks: 2,
        triggerEpoch: latest.epoch,
        signalId: `${symbol}:${latest.epoch}:${direction}:${runLength}`,
    };
};

export const isSymbolSelected = (symbol: string, settings: AnalyzerSettings) =>
    settings.allMarkets || settings.selectedSymbols.includes(symbol);

export const clampConcurrentEntries = (value: number) => Math.max(1, Math.min(100, Math.round(value || 1)));

export const getAccountKind = (loginid: string) => (loginid.startsWith('VRT') || loginid.startsWith('VRTC') ? 'Demo' : 'Real');

export const getAnalyzerXmlFields = (settings: AnalyzerSettings) => ({
    enabled: true,
    all_markets: settings.allMarkets,
    symbols: settings.selectedSymbols,
    minimum_run: settings.minimumRun,
    prediction_ticks: settings.predictionTicks,
    entry_mode: settings.entryMode,
    account_id: settings.accountId,
    max_concurrent_entries: settings.maxConcurrentEntries,
});

export const formatQuote = (quote: number) => (Number.isFinite(quote) ? quote.toFixed(5) : '--');

export const getDefaultSymbols = (activeSymbols: any[]) =>
    activeSymbols
        .filter(symbol => symbol?.symbol || symbol?.underlying_symbol)
        .map(symbol => ({
            symbol: String(symbol.symbol || symbol.underlying_symbol),
            displayName: String(symbol.display_name || symbol.display_name_en || symbol.symbol || symbol.underlying_symbol),
            market: String(symbol.market || ''),
            submarket: String(symbol.submarket || ''),
        }))
        .filter((item, index, array) => array.findIndex(candidate => candidate.symbol === item.symbol) === index);

export const safeJson = (value: unknown) => {
    try {
        return JSON.stringify(value);
    } catch {
        return '{}';
    }
};
