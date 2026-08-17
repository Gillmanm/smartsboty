import { localize } from '@deriv-com/translations';

const analyzerBoolean = value => String(value) === 'TRUE';

window.Blockly.Blocks.trade_definition_market_analyzer = {
    init() {
        this.jsonInit({
            message0: localize('Market analyzer {{ scope }} {{ symbols }}'),
            message1: localize('{{ run_length }}+ same-direction ticks → opposite signal for 2 ticks'),
            message2: localize('Entry: {{ entry_mode }} · Max concurrent: {{ max_concurrent }}'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'MARKET_SCOPE',
                    options: [
                        [localize('all markets'), 'ALL'],
                        [localize('selected markets'), 'SELECTED'],
                    ],
                },
                {
                    type: 'field_input',
                    name: 'SYMBOLS',
                    text: '',
                },
            ],
            args1: [
                {
                    type: 'field_number',
                    name: 'MIN_RUN',
                    value: 4,
                    min: 4,
                    max: 100,
                    precision: 1,
                },
            ],
            args2: [
                {
                    type: 'field_dropdown',
                    name: 'ENTRY_MODE',
                    options: [
                        [localize('manual'), 'manual'],
                        [localize('automatic'), 'automatic'],
                    ],
                },
                {
                    type: 'field_number',
                    name: 'MAX_CONCURRENT',
                    value: 1,
                    min: 1,
                    max: 100,
                    precision: 1,
                },
            ],
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize('Configure the in-browser market analyzer and its safe entry controls.'),
            category: window.Blockly.Categories.Trade_Definition,
        });
        this.setInputsInline(true);
    },
    meta() {
        return {
            display_name: localize('Market analyzer strategy'),
            description: localize('Detect four or more consecutive ticks and prepare an opposite-direction two-tick signal.'),
            key_words: localize('market analyzer, reversal, signal, automatic entry, concurrent entries'),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.trade_definition_market_analyzer = block => {
    const scope = block.getFieldValue('MARKET_SCOPE') || 'ALL';
    const symbols = String(block.getFieldValue('SYMBOLS') || '')
        .split(',')
        .map(symbol => symbol.trim())
        .filter(Boolean);
    const minimumRun = Math.max(4, Math.min(100, Number(block.getFieldValue('MIN_RUN')) || 4));
    const entryMode = block.getFieldValue('ENTRY_MODE') || 'manual';
    const maxConcurrentEntries = Math.max(1, Math.min(100, Number(block.getFieldValue('MAX_CONCURRENT')) || 1));
    const config = {
        allMarkets: scope === 'ALL',
        selectedSymbols: symbols,
        minimumRun,
        predictionTicks: 2,
        entryMode,
        maxConcurrentEntries,
    };

    return `
        window.DerivMarketAnalyzerConfig = ${JSON.stringify(config)};
        if (window.SmartbotMarketAnalyzer && typeof window.SmartbotMarketAnalyzer.configure === 'function') {
            window.SmartbotMarketAnalyzer.configure(window.DerivMarketAnalyzerConfig);
            if (typeof window.SmartbotMarketAnalyzer.start === 'function') {
                window.SmartbotMarketAnalyzer.start();
            }
        }
    `;
};
