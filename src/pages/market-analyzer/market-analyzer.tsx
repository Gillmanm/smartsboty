import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import {
    AnalyzerSignal,
    AnalyzerSettings,
    AnalyzerTick,
    DEFAULT_ANALYZER_SETTINGS,
    clampConcurrentEntries,
    detectReversalSignal,
    formatQuote,
    getAccountKind,
    getDefaultSymbols,
    getMovementTrail,
    getTickDirection,
    isSymbolSelected,
} from './market-analyzer-utils';
import './market-analyzer.scss';

type MarketAnalyzerProps = {
    runtimeOnly?: boolean;
};

type SymbolDescriptor = {
    symbol: string;
    displayName: string;
    market: string;
    submarket: string;
};

type ActiveEntry = {
    contractId?: number;
    symbol: string;
    createdAt: number;
};

type TickMap = Record<string, AnalyzerTick[]>;
type RunMap = Record<string, { direction: 'up' | 'down' | null; count: number; alerted: boolean }>;

const MAX_TICK_HISTORY = 32;

const getLoginId = () => localStorage.getItem('active_loginid') || (api_base.account_info as any)?.loginid || '';

const MarketAnalyzer = ({ runtimeOnly = false }: MarketAnalyzerProps) => {
    const storedConfig = (window as any).DerivMarketAnalyzerConfig || {};
    const { accountList, isAuthorized, activeLoginid } = useApiBase();
    const { run_panel } = useStore();
    const [settings, setSettings] = useState<AnalyzerSettings>({
        ...DEFAULT_ANALYZER_SETTINGS,
        ...storedConfig,
        predictionTicks: 2,
        minimumRun: Math.max(4, Number(storedConfig.minimumRun || DEFAULT_ANALYZER_SETTINGS.minimumRun)),
        maxConcurrentEntries: clampConcurrentEntries(storedConfig.maxConcurrentEntries || DEFAULT_ANALYZER_SETTINGS.maxConcurrentEntries),
        accountId: storedConfig.accountId || activeLoginid || getLoginId(),
    });
    const [symbols, setSymbols] = useState<SymbolDescriptor[]>([]);
    const [ticks, setTicks] = useState<TickMap>({});
    const [signals, setSignals] = useState<AnalyzerSignal[]>([]);
    const [activeEntries, setActiveEntries] = useState<ActiveEntry[]>([]);
    const [isMonitoring, setIsMonitoring] = useState(false);
    const [isOverlay, setIsOverlay] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [statusMessage, setStatusMessage] = useState('Ready. Choose markets and start the analyzer.');

    const tickHistoryRef = useRef<TickMap>({});
    const runMapRef = useRef<RunMap>({});
    const alertedSignalsRef = useRef(new Set<string>());
    const activeEntriesRef = useRef<ActiveEntry[]>([]);
    const subscriptionsRef = useRef<string[]>([]);
    const messageSubscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);
    const mountedRef = useRef(true);

    const refreshSymbols = useCallback(() => {
        const nextSymbols = getDefaultSymbols(api_base.active_symbols || []);
        if (nextSymbols.length) setSymbols(nextSymbols);
    }, []);

    useEffect(() => {
        refreshSymbols();
        const poll = window.setInterval(refreshSymbols, 2000);
        return () => window.clearInterval(poll);
    }, [refreshSymbols]);

    useEffect(() => {
        if (!settings.accountId && (activeLoginid || getLoginId())) {
            setSettings(current => ({ ...current, accountId: activeLoginid || getLoginId() }));
        }
    }, [activeLoginid, settings.accountId]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            stopMonitoring();
        };
        // stopMonitoring intentionally uses refs and is stable for teardown.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const selectedSymbols = useMemo(
        () => symbols.filter(symbol => isSymbolSelected(symbol.symbol, settings)),
        [settings, symbols]
    );

    const groupedSymbols = useMemo(() => {
        return symbols.reduce<Record<string, SymbolDescriptor[]>>((groups, item) => {
            const key = item.market || 'Other';
            groups[key] = groups[key] || [];
            groups[key].push(item);
            return groups;
        }, {});
    }, [symbols]);

    const updateSettings = <K extends keyof AnalyzerSettings>(key: K, value: AnalyzerSettings[K]) => {
        setSettings(current => ({ ...current, [key]: value }));
    };

    const clearSubscriptionRequests = useCallback(() => {
        subscriptionsRef.current.forEach(subscriptionId => {
            try {
                api_base.api?.send({ forget: subscriptionId });
            } catch (error) {
                console.warn('Unable to forget analyzer subscription', error);
            }
        });
        subscriptionsRef.current = [];
    }, []);

    const stopMonitoring = useCallback(() => {
        clearSubscriptionRequests();
        messageSubscriptionRef.current?.unsubscribe?.();
        messageSubscriptionRef.current = null;
        setIsMonitoring(false);
        setStatusMessage('Analyzer stopped. No new entries will be placed.');
    }, [clearSubscriptionRequests]);

    const releaseEntry = useCallback((contractId: number) => {
        activeEntriesRef.current = activeEntriesRef.current.filter(entry => entry.contractId !== contractId);
        setActiveEntries([...activeEntriesRef.current]);
    }, []);

    const releasePendingEntry = useCallback((createdAt: number) => {
        activeEntriesRef.current = activeEntriesRef.current.filter(entry => entry.createdAt !== createdAt);
        setActiveEntries([...activeEntriesRef.current]);
    }, []);

    const placeEntry = useCallback(
        async (signal: AnalyzerSignal) => {
            if (!api_base.api || !isAuthorized) {
                setErrorMessage('Log in to a Deriv account before placing an entry.');
                return;
            }
            if (activeEntriesRef.current.length >= settings.maxConcurrentEntries) {
                setErrorMessage(`Maximum concurrent entries (${settings.maxConcurrentEntries}) reached.`);
                return;
            }
            if (run_panel?.is_running) {
                setErrorMessage('Stop the XML block bot before using analyzer entries to avoid duplicate trades.');
                return;
            }
            if (settings.stake <= 0 || !Number.isFinite(settings.stake)) {
                setErrorMessage('Stake must be greater than zero.');
                return;
            }

            setErrorMessage('');
            const pendingEntry: ActiveEntry = { symbol: signal.symbol, createdAt: Date.now() };
            activeEntriesRef.current = [...activeEntriesRef.current, pendingEntry];
            setActiveEntries([...activeEntriesRef.current]);

            try {
                const proposalRequest = {
                    req_id: Date.now(),
                    proposal: 1,
                    amount: settings.stake,
                    basis: 'stake',
                    contract_type: signal.direction,
                    currency: settings.currency,
                    duration: signal.durationTicks,
                    duration_unit: 't',
                    symbol: signal.symbol,
                    subscribe: 1,
                };

                api_base.api.send(proposalRequest);
                const proposal = await new Promise<any>((resolve, reject) => {
                    const timeout = window.setTimeout(() => reject(new Error('Proposal request timed out.')), 12000);
                    const subscription = api_base.api?.onMessage().subscribe((response: any) => {
                        if (response?.req_id === proposalRequest.req_id && response?.msg_type === 'proposal' && response?.proposal?.id) {
                            window.clearTimeout(timeout);
                            subscription?.unsubscribe?.();
                            resolve(response.proposal);
                        } else if (response?.error) {
                            window.clearTimeout(timeout);
                            subscription?.unsubscribe?.();
                            reject(new Error(response.error.message || 'Proposal was rejected.'));
                        }
                    });
                });

                const buyRequest = { req_id: Date.now() + 1, buy: proposal.id, price: proposal.ask_price };
                api_base.api.send(buyRequest);
                const buyResponse = await new Promise<any>((resolve, reject) => {
                    const timeout = window.setTimeout(() => reject(new Error('Buy request timed out.')), 12000);
                    const subscription = api_base.api?.onMessage().subscribe((response: any) => {
                        if (response?.req_id === buyRequest.req_id && response?.msg_type === 'buy' && response?.buy?.contract_id) {
                            window.clearTimeout(timeout);
                            subscription?.unsubscribe?.();
                            resolve(response.buy);
                        } else if (response?.error) {
                            window.clearTimeout(timeout);
                            subscription?.unsubscribe?.();
                            reject(new Error(response.error.message || 'Entry was rejected.'));
                        }
                    });
                });

                const withContract = activeEntriesRef.current.map(entry =>
                    entry.symbol === signal.symbol && !entry.contractId && entry.createdAt === pendingEntry.createdAt
                        ? { ...entry, contractId: buyResponse.contract_id }
                        : entry
                );
                activeEntriesRef.current = withContract;
                setActiveEntries([...withContract]);
                setStatusMessage(`${signal.symbol}: ${signal.direction === 'CALL' ? 'Up' : 'Down'} entry placed for 2 ticks.`);

                const contractSubscription = api_base.api?.onMessage().subscribe((response: any) => {
                    const contract = response?.proposal_open_contract;
                    if (contract?.contract_id === buyResponse.contract_id && contract.status && contract.status !== 'open') {
                        contractSubscription?.unsubscribe?.();
                        releaseEntry(buyResponse.contract_id);
                    }
                });
            } catch (error) {
                releasePendingEntry(pendingEntry.createdAt);
                setErrorMessage(error instanceof Error ? error.message : 'Unable to place the entry.');
            }
        },
        [isAuthorized, releaseEntry, releasePendingEntry, run_panel?.is_running, settings.currency, settings.maxConcurrentEntries, settings.stake]
    );

    const acceptSignal = useCallback(
        (signal: AnalyzerSignal) => {
            if (settings.entryMode === 'automatic') {
                void placeEntry(signal);
            }
        },
        [placeEntry, settings.entryMode]
    );

    const processTick = useCallback(
        (symbol: string, tick: AnalyzerTick) => {
            const previousTicks = tickHistoryRef.current[symbol] || [];
            const nextTicks = [...previousTicks, tick].slice(-MAX_TICK_HISTORY);
            tickHistoryRef.current[symbol] = nextTicks;
            setTicks(current => ({ ...current, [symbol]: nextTicks }));

            const previousQuote = previousTicks[previousTicks.length - 1]?.quote;
            const direction = getTickDirection(previousQuote, tick.quote);
            const runState = runMapRef.current[symbol] || { direction: null, count: 0, alerted: false };

            if (direction === 'flat') {
                runMapRef.current[symbol] = { direction: null, count: 0, alerted: false };
                return;
            }
            if (runState.direction === direction) {
                runState.count += 1;
            } else {
                runMapRef.current[symbol] = { direction, count: 1, alerted: false };
            }

            const latestRun = runMapRef.current[symbol];
            if (!latestRun || latestRun.count < settings.minimumRun || latestRun.alerted) return;
            latestRun.alerted = true;

            const signal = detectReversalSignal(symbol, nextTicks, settings.minimumRun);
            if (!signal || alertedSignalsRef.current.has(signal.signalId) || !isSymbolSelected(symbol, settings)) return;

            alertedSignalsRef.current.add(signal.signalId);
            setSignals(current => [signal, ...current].slice(0, 24));
            setStatusMessage(`${symbol}: ${signal.runLength} consecutive ${signal.triggerDirection} ticks detected; opposite signal ready.`);
            acceptSignal(signal);
        },
        [acceptSignal, settings]
    );

    const startMonitoring = useCallback(() => {
        if (!api_base.api || !isAuthorized) {
            setErrorMessage('Log in to a Deriv account before starting the analyzer.');
            return;
        }
        if (!selectedSymbols.length) {
            setErrorMessage('Select at least one market or enable All markets.');
            return;
        }
        if (settings.entryMode === 'automatic') {
            const accountKind = getAccountKind(settings.accountId || getLoginId());
            const confirmed = window.confirm(
                `Automatic entries are enabled on the ${accountKind} account. The analyzer will place ${settings.currency} ${settings.stake} entries for 2 ticks when a signal appears. Continue?`
            );
            if (!confirmed) return;
        }

        stopMonitoring();
        tickHistoryRef.current = {};
        runMapRef.current = {};
        alertedSignalsRef.current.clear();
        setTicks({});
        setSignals([]);
        setErrorMessage('');
        setIsMonitoring(true);
        setStatusMessage(`Monitoring ${selectedSymbols.length} market${selectedSymbols.length === 1 ? '' : 's'}...`);

        const subscription = api_base.api.onMessage().subscribe((response: any) => {
            const tick = response?.tick;
            if (!tick?.symbol || typeof tick.quote !== 'number') return;
            processTick(String(tick.symbol), { quote: Number(tick.quote), epoch: Number(tick.epoch || Date.now()) });

            if (response.subscription?.id && !subscriptionsRef.current.includes(response.subscription.id)) {
                subscriptionsRef.current.push(response.subscription.id);
            }
        });
        messageSubscriptionRef.current = subscription;

        selectedSymbols.forEach(item => {
            api_base.api?.send({ ticks: item.symbol, subscribe: 1 });
        });
    }, [isAuthorized, processTick, selectedSymbols, settings.accountId, settings.currency, settings.entryMode, settings.stake, stopMonitoring]);

    const toggleSymbol = (symbol: string) => {
        setSettings(current => {
            const selected = current.selectedSymbols.includes(symbol)
                ? current.selectedSymbols.filter(item => item !== symbol)
                : [...current.selectedSymbols, symbol];
            return { ...current, selectedSymbols: selected, allMarkets: false };
        });
    };

    const switchAccount = async (accountId: string) => {
        if (isMonitoring) stopMonitoring();
        const account = accountList.find(item => item.loginid === accountId);
        if (!account) return;
        const confirmed = window.confirm(`Switch Smartbot to the ${getAccountKind(accountId)} account ${accountId}?`);
        if (!confirmed) return;
        localStorage.setItem('active_loginid', accountId);
        localStorage.setItem('account_type', getAccountKind(accountId).toLowerCase());
        updateSettings('accountId', accountId);
        try {
            await api_base.init(true);
            setStatusMessage(`Connected to ${getAccountKind(accountId)} account ${accountId}.`);
        } catch {
            setErrorMessage('Account switch failed. Please reconnect and try again.');
        }
    };

    useEffect(() => {
        const bridge = {
            configure: (config: Partial<AnalyzerSettings>) => {
                (window as any).DerivMarketAnalyzerConfig = {
                    ...(window as any).DerivMarketAnalyzerConfig,
                    ...config,
                    maxConcurrentEntries: clampConcurrentEntries(
                        config.maxConcurrentEntries ?? DEFAULT_ANALYZER_SETTINGS.maxConcurrentEntries
                    ),
                };
                setSettings(current => ({
                    ...current,
                    ...config,
                    maxConcurrentEntries: clampConcurrentEntries(config.maxConcurrentEntries ?? current.maxConcurrentEntries),
                }));
            },
            start: () => {
                window.setTimeout(() => startMonitoring(), 0);
            },
            stop: stopMonitoring,
            placeEntry,
        };
        (window as any).SmartbotMarketAnalyzer = bridge;
        return () => {
            if ((window as any).SmartbotMarketAnalyzer === bridge) {
                delete (window as any).SmartbotMarketAnalyzer;
            }
        };
    }, [placeEntry, startMonitoring, stopMonitoring]);

    const latestSignal = signals[0];
    const activeAccountId = settings.accountId || getLoginId();

    if (runtimeOnly) return null;

    return (
        <section className={classNames('market-analyzer', { 'market-analyzer--overlay': isOverlay })}>
            <header className='market-analyzer__header'>
                <div>
                    <span className='market-analyzer__eyebrow'>Smartbot intelligence</span>
                    <h1>Market Analyzer</h1>
                    <p>Monitor consecutive tick movement and prepare an opposite-direction, two-tick signal.</p>
                </div>
                <div className='market-analyzer__header-actions'>
                    <button type='button' className='market-analyzer__button market-analyzer__button--ghost' onClick={() => setIsOverlay(current => !current)}>
                        {isOverlay ? 'Exit overlay' : 'Open overlay'}
                    </button>
                    <button type='button' className='market-analyzer__button market-analyzer__button--primary' onClick={isMonitoring ? stopMonitoring : startMonitoring}>
                        {isMonitoring ? 'Stop analyzer' : 'Start analyzer'}
                    </button>
                </div>
            </header>

            <div className='market-analyzer__notice'>
                <strong>Signal rule:</strong> after <b>{settings.minimumRun}+</b> consecutive up ticks, the analyzer suggests <b>Down / PUT</b> for <b>2 ticks</b>; after {settings.minimumRun}+ consecutive down ticks, it suggests <b>Up / CALL</b> for 2 ticks. A direction produces one signal per uninterrupted run.
            </div>

            <div className='market-analyzer__layout'>
                <aside className='market-analyzer__controls'>
                    <div className='market-analyzer__card'>
                        <div className='market-analyzer__card-title'>Entry configuration</div>
                        <label className='market-analyzer__field'>
                            <span>Account</span>
                            <select value={activeAccountId} onChange={event => void switchAccount(event.target.value)} disabled={isMonitoring}>
                                {accountList.length ? accountList.map(account => (
                                    <option key={account.loginid} value={account.loginid}>
                                        {getAccountKind(account.loginid)} · {account.loginid} · {account.currency}
                                    </option>
                                )) : <option value={activeAccountId || ''}>{activeAccountId || 'Not connected'}</option>}
                            </select>
                        </label>
                        <label className='market-analyzer__field'>
                            <span>Entry mode</span>
                            <select value={settings.entryMode} onChange={event => updateSettings('entryMode', event.target.value as AnalyzerSettings['entryMode'])}>
                                <option value='manual'>Manual confirmation</option>
                                <option value='automatic'>Automatic entry</option>
                            </select>
                        </label>
                        <div className='market-analyzer__field-row'>
                            <label className='market-analyzer__field'>
                                <span>Stake</span>
                                <input type='number' min='0.01' step='0.01' value={settings.stake} onChange={event => updateSettings('stake', Number(event.target.value))} />
                            </label>
                            <label className='market-analyzer__field'>
                                <span>Currency</span>
                                <input value={settings.currency} maxLength={8} onChange={event => updateSettings('currency', event.target.value.toUpperCase())} />
                            </label>
                        </div>
                        <label className='market-analyzer__field'>
                            <span>Maximum concurrent entries: {settings.maxConcurrentEntries}</span>
                            <input type='range' min='1' max='100' value={settings.maxConcurrentEntries} onChange={event => updateSettings('maxConcurrentEntries', clampConcurrentEntries(Number(event.target.value)))} />
                        </label>
                    </div>

                    <div className='market-analyzer__card'>
                        <div className='market-analyzer__card-title'>Signal configuration</div>
                        <label className='market-analyzer__field'>
                            <span>Minimum consecutive movement</span>
                            <input type='number' min='4' max='100' value={settings.minimumRun} onChange={event => updateSettings('minimumRun', Math.max(4, Math.min(100, Number(event.target.value) || 4)))} />
                        </label>
                        <div className='market-analyzer__read-only'>Prediction duration <strong>2 ticks</strong></div>
                        <div className='market-analyzer__read-only'>Contract types <strong>Up / Down</strong></div>
                    </div>

                    <div className='market-analyzer__card'>
                        <div className='market-analyzer__card-title'>Market selection</div>
                        <label className='market-analyzer__checkbox market-analyzer__checkbox--all'>
                            <input type='checkbox' checked={settings.allMarkets} onChange={event => updateSettings('allMarkets', event.target.checked)} />
                            <span>All available markets</span>
                        </label>
                        <p className='market-analyzer__hint'>Disable this option to prioritize specific markets. The analyzer streams only the markets selected below.</p>
                        <div className='market-analyzer__markets'>
                            {Object.entries(groupedSymbols).map(([market, marketSymbols]) => (
                                <details key={market} open>
                                    <summary>{market} <span>{marketSymbols.length}</span></summary>
                                    {marketSymbols.map(item => (
                                        <label className='market-analyzer__checkbox' key={item.symbol}>
                                            <input type='checkbox' checked={settings.allMarkets || settings.selectedSymbols.includes(item.symbol)} onChange={() => toggleSymbol(item.symbol)} />
                                            <span>{item.displayName}</span>
                                            <small>{item.symbol}</small>
                                        </label>
                                    ))}
                                </details>
                            ))}
                            {!symbols.length && <div className='market-analyzer__empty'>Connect an account to load available markets.</div>}
                        </div>
                    </div>
                </aside>

                <main className='market-analyzer__workspace'>
                    <div className='market-analyzer__status-row'>
                        <div className={classNames('market-analyzer__status', { 'market-analyzer__status--live': isMonitoring })}>
                            <span className='market-analyzer__status-dot' />
                            {isMonitoring ? 'Monitoring live ticks' : 'Analyzer idle'}
                        </div>
                        <span>{selectedSymbols.length} market{selectedSymbols.length === 1 ? '' : 's'} selected</span>
                        <span>{activeEntries.length}/{settings.maxConcurrentEntries} active entries</span>
                    </div>

                    {errorMessage && <div className='market-analyzer__alert market-analyzer__alert--error'>{errorMessage}</div>}
                    <div className='market-analyzer__alert'>{statusMessage}</div>

                    <div className='market-analyzer__card market-analyzer__card--signal'>
                        <div className='market-analyzer__card-heading'>
                            <div>
                                <div className='market-analyzer__card-title'>Latest analyzer signal</div>
                                <p>Signals are generated once per uninterrupted four-plus tick run.</p>
                            </div>
                            {latestSignal && <span className={classNames('market-analyzer__signal-badge', latestSignal.direction === 'CALL' ? 'market-analyzer__signal-badge--up' : 'market-analyzer__signal-badge--down')}>{latestSignal.direction === 'CALL' ? 'UP / CALL' : 'DOWN / PUT'}</span>}
                        </div>
                        {latestSignal ? (
                            <div className='market-analyzer__signal-content'>
                                <div><span>Market</span><strong>{latestSignal.symbol}</strong></div>
                                <div><span>Trigger</span><strong>{latestSignal.runLength} consecutive {latestSignal.triggerDirection} ticks</strong></div>
                                <div><span>Prediction</span><strong>{latestSignal.durationTicks} ticks</strong></div>
                                {settings.entryMode === 'manual' && <button type='button' className='market-analyzer__button market-analyzer__button--primary' onClick={() => void placeEntry(latestSignal)}>Place entry</button>}
                            </div>
                        ) : <div className='market-analyzer__empty'>Start the analyzer to receive signals. Automatic mode will place an entry only when the explicit automatic-entry confirmation has been accepted.</div>}
                    </div>

                    <div className='market-analyzer__card'>
                        <div className='market-analyzer__card-heading'>
                            <div>
                                <div className='market-analyzer__card-title'>Live market movement</div>
                                <p>Latest quote, direction, and current consecutive run.</p>
                            </div>
                        </div>
                        <div className='market-analyzer__table-wrapper'>
                            <table className='market-analyzer__table'>
                                <thead><tr><th>Market</th><th>Quote</th><th>Move</th><th>Rise/Fall trail</th><th>Run</th><th>Signal</th></tr></thead>
                                <tbody>
                                    {selectedSymbols.slice(0, 100).map(item => {
                                        const marketTicks = ticks[item.symbol] || [];
                                        const latest = marketTicks[marketTicks.length - 1];
                                        const previous = marketTicks[marketTicks.length - 2];
                                        const move = getTickDirection(previous?.quote, latest?.quote);
                                        const movementTrail = getMovementTrail(marketTicks, 4);
                                        const trailSlots = Array.from({ length: 4 }, (_, index) => movementTrail[index - (4 - movementTrail.length)] || 'flat');
                                        const trailLabel = movementTrail.length
                                            ? movementTrail.map(direction => direction === 'up' ? 'Rise' : direction === 'down' ? 'Fall' : 'Flat').join(', ')
                                            : 'Waiting for movement';
                                        const run = runMapRef.current[item.symbol]?.count || 0;
                                        return <tr key={item.symbol}>
                                            <td><strong>{item.symbol}</strong><small>{item.displayName}</small></td>
                                            <td>{latest ? formatQuote(latest.quote) : '--'}</td>
                                            <td className={move === 'up' ? 'is-up' : move === 'down' ? 'is-down' : ''}>{move === 'up' ? 'Rise' : move === 'down' ? 'Fall' : '—'}</td>
                                            <td className='market-analyzer__trail-cell'>
                                                <div className='market-analyzer__trail' role='img' aria-label={`${item.symbol} latest movements: ${trailLabel}`}>
                                                    {trailSlots.map((direction, index) => <span
                                                        className={classNames('market-analyzer__trail-dot', `market-analyzer__trail-dot--${direction}`)}
                                                        key={`${item.symbol}-trail-${index}`}
                                                        title={direction === 'up' ? 'Rise' : direction === 'down' ? 'Fall' : 'Waiting'}
                                                    >{direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•'}</span>)}
                                                </div>
                                                <small>{movementTrail.length}/4 moves</small>
                                            </td>
                                            <td>{run}</td>
                                            <td>{run >= settings.minimumRun ? (move === 'up' ? 'Down next' : move === 'down' ? 'Up next' : 'Waiting') : 'Watching'}</td>
                                        </tr>;
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className='market-analyzer__card'>
                        <div className='market-analyzer__card-heading'><div><div className='market-analyzer__card-title'>Signal history</div><p>Review and manually enter any signal when manual mode is selected.</p></div></div>
                        <div className='market-analyzer__signals'>
                            {signals.length ? signals.map(signal => <div className='market-analyzer__signal-row' key={signal.signalId}>
                                <div><strong>{signal.symbol}</strong><span>{signal.runLength} {signal.triggerDirection} ticks → {signal.direction === 'CALL' ? 'Up / CALL' : 'Down / PUT'} for 2 ticks</span></div>
                                <div>{settings.entryMode === 'manual' && <button type='button' className='market-analyzer__button market-analyzer__button--small' onClick={() => void placeEntry(signal)}>Place entry</button>}</div>
                            </div>) : <div className='market-analyzer__empty'>No signals yet.</div>}
                        </div>
                    </div>

                    <div className='market-analyzer__xml-note'><strong>Blockly/XML connection:</strong> add the <em>Market analyzer strategy</em> block from the Trade parameters toolbox. It stores this analyzer configuration in the bot XML and calls the analyzer runtime when the XML bot starts, while the analyzer panel remains the place to monitor signals and choose manual or automatic entries.</div>
                </main>
            </div>
        </section>
    );
};

export default MarketAnalyzer;
