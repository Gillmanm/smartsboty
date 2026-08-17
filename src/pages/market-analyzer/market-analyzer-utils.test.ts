import {
    clampConcurrentEntries,
    detectReversalSignal,
    getMovementTrail,
    getOppositeContract,
    getTickDirection,
} from './market-analyzer-utils';

describe('market analyzer signal rules', () => {
    it('detects Down/PUT after four consecutive up movements', () => {
        const signal = detectReversalSignal('R_100', [
            { quote: 100, epoch: 1 },
            { quote: 101, epoch: 2 },
            { quote: 102, epoch: 3 },
            { quote: 103, epoch: 4 },
            { quote: 104, epoch: 5 },
        ]);

        expect(signal).toMatchObject({
            symbol: 'R_100',
            direction: 'PUT',
            triggerDirection: 'up',
            runLength: 4,
            durationTicks: 2,
        });
    });

    it('detects Up/CALL after four consecutive down movements', () => {
        const signal = detectReversalSignal('R_50', [
            { quote: 100, epoch: 1 },
            { quote: 99, epoch: 2 },
            { quote: 98, epoch: 3 },
            { quote: 97, epoch: 4 },
            { quote: 96, epoch: 5 },
        ]);

        expect(signal?.direction).toBe('CALL');
        expect(signal?.triggerDirection).toBe('down');
    });

    it('does not signal before four moves and resets on a flat tick', () => {
        expect(
            detectReversalSignal('R_100', [
                { quote: 100, epoch: 1 },
                { quote: 101, epoch: 2 },
                { quote: 102, epoch: 3 },
                { quote: 102, epoch: 4 },
                { quote: 103, epoch: 5 },
            ])
        ).toBeNull();
    });

    it('clamps simultaneous entries to the configured 1-100 range', () => {
        expect(clampConcurrentEntries(0)).toBe(1);
        expect(clampConcurrentEntries(40.6)).toBe(41);
        expect(clampConcurrentEntries(1000)).toBe(100);
    });

    it('returns the latest four rise/fall movements for the visual trail', () => {
        expect(
            getMovementTrail([
                { quote: 100, epoch: 1 },
                { quote: 101, epoch: 2 },
                { quote: 100, epoch: 3 },
                { quote: 100, epoch: 4 },
                { quote: 102, epoch: 5 },
                { quote: 101, epoch: 6 },
                { quote: 103, epoch: 7 },
            ])
        ).toEqual(['flat', 'up', 'down', 'up']);

        expect(getMovementTrail([{ quote: 100, epoch: 1 }])).toEqual([]);
        expect(getMovementTrail([{ quote: 100, epoch: 1 }, { quote: 100, epoch: 2 }])).toEqual(['flat']);
        expect(getMovementTrail([
            { quote: 1, epoch: 1 },
            { quote: 2, epoch: 2 },
            { quote: 3, epoch: 3 },
            { quote: 4, epoch: 4 },
            { quote: 5, epoch: 5 },
            { quote: 6, epoch: 6 },
        ])).toEqual(['up', 'up', 'up', 'up']);
    });

    it('maps movement direction to the opposite contract', () => {
        expect(getTickDirection(100, 101)).toBe('up');
        expect(getTickDirection(100, 99)).toBe('down');
        expect(getOppositeContract('up')).toBe('PUT');
        expect(getOppositeContract('down')).toBe('CALL');
    });
});
