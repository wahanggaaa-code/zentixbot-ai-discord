import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTING_SYSTEMS, evaluateExpression, formatCount, isCountingSystem, matchesCount } from '../src/services/countingGame/systems.js';

test('every system accepts its own way of writing a number and no neighbouring number', () => {
    for (const system of Object.keys(COUNTING_SYSTEMS)) {
        for (const n of [1, 2, 9, 10, 15, 16, 26, 27, 35, 36, 63, 64, 255, 1000, 3999, 4000, 123456]) {
            const text = formatCount(system, n);
            assert.equal(matchesCount(system, text, n), true, `${system} ${n} as ${text}`);
            assert.equal(matchesCount(system, `  ${text}\n`, n), true, `${system} ${n} with spaces around`);
            assert.equal(matchesCount(system, text, n + 1), false, `${system}: ${text} is not ${n + 1}`);
            assert.equal(matchesCount(system, formatCount(system, n + 1), n), false, `${system}: ${n + 1} is not ${n}`);
        }
        assert.equal(matchesCount(system, '', 1), false);
        assert.equal(matchesCount(system, '   ', 1), false);
        assert.equal(matchesCount(system, undefined, 1), false);
        assert.equal(matchesCount(system, 'hello there', 1), false);
    }
});

test('how each system writes numbers', () => {
    const written = (system, numbers) => numbers.map((n) => formatCount(system, n));
    assert.deepEqual(written('decimal', [1, 10, 255]), ['1', '10', '255']);
    assert.deepEqual(written('hexadecimal', [10, 255, 4096]), ['A', 'FF', '1000']);
    assert.deepEqual(written('binary', [1, 2, 5]), ['1', '10', '101']);
    assert.deepEqual(written('base36', [10, 35, 36]), ['A', 'Z', '10']);
    assert.deepEqual(written('base64', [1, 26, 63, 64]), ['B', 'a', '/', 'BA']);
    assert.deepEqual(written('roman', [4, 9, 14, 40, 90, 400, 1994, 3999, 4000]), ['IV', 'IX', 'XIV', 'XL', 'XC', 'CD', 'MCMXCIV', 'MMMCMXCIX', 'MMMM']);
    assert.deepEqual(written('alphabet', [1, 26, 27, 52, 53, 702, 703]), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    // An unknown system is treated as decimal everywhere.
    assert.equal(formatCount('klingon', 7), '7');
    assert.equal(matchesCount('klingon', '7', 7), true);
    assert.equal(isCountingSystem('klingon'), false);
    assert.equal(isCountingSystem('toString'), false, 'inherited names are not systems');
    assert.equal(isCountingSystem('roman'), true);
});

test('letter case: free where the digits have no case of their own, strict in base 64', () => {
    assert.equal(matchesCount('hexadecimal', 'ff', 255), true);
    assert.equal(matchesCount('hexadecimal', 'Ff', 255), true);
    assert.equal(matchesCount('base36', 'z', 35), true);
    assert.equal(matchesCount('roman', 'mcmxciv', 1994), true);
    assert.equal(matchesCount('alphabet', 'ab', 28), true);
    // In base 64 "B" is 1 and "b" is 27.
    assert.equal(matchesCount('base64', 'b', 1), false);
    assert.equal(matchesCount('base64', 'b', 27), true);
    // One spelling per number.
    assert.equal(matchesCount('decimal', '05', 5), false);
    assert.equal(matchesCount('decimal', '5.0', 5), false);
    assert.equal(matchesCount('decimal', '+5', 5), false);
    assert.equal(matchesCount('binary', '0101', 5), false);
    assert.equal(matchesCount('roman', 'IIII', 4), false);
    assert.equal(matchesCount('roman', 'VIIII', 9), false);
});

test('math: the usual rules of arithmetic', () => {
    const cases = {
        '4*4': 16, '2+3*4': 14, '(2+3)*4': 20, '10-4-3': 3, '100/10/5': 2, '2**3**2': 512, '2^10': 1024, '-2**2': -4, '(-2)**2': 4,
        '3*-2': -6, '--5': 5, '+5': 5, '2**-1': 0.5, '1.5*2': 3, '.5*4': 2, '10/4': 2.5, '((((7))))': 7, '2*(3+(4-1))': 12, '7': 7,
    };
    for (const [text, value] of Object.entries(cases)) assert.equal(evaluateExpression(text), value, text);
});

test('math: anything that is not arithmetic is refused, and nothing is executed', (t) => {
    const refused = [
        '', '2*', '*2', '5//', '(1)(2)', '(1+2', '1+2)', '()', '1 2', '1e3', '0x10', '1,5', '1_000', '5!', '2***2', '2^^2', '1..2', '.',
        '1/0', '0/0', '9**9**9', '-9**9**9',
        'process.exit()', 'constructor', 'this', 'Infinity', 'NaN', 'globalThis.x=1', '1;2', '`1`', '[1]', '1n', 'a', '1+a',
        '('.repeat(60) + '1' + ')'.repeat(60),
        '-'.repeat(120) + '1',
        '1+'.repeat(120) + '1',
    ];
    for (const text of refused) assert.equal(evaluateExpression(text), null, JSON.stringify(text.slice(0, 30)));
    assert.equal(evaluateExpression(5), null);
    assert.equal(evaluateExpression(null), null);
    assert.equal(globalThis.x, undefined);

    // A long but allowed expression is answered quickly.
    const started = Date.now();
    for (let i = 0; i < 2000; i++) evaluateExpression('((((1+2)*3)-4)/5)**2+7*8-9/3+' + '1+'.repeat(60) + '1');
    assert.ok(Date.now() - started < 2000, 'evaluation stays cheap');
});

test('math as a count: the value must equal the next number exactly', () => {
    assert.equal(matchesCount('math', '4*4', 16), true);
    assert.equal(matchesCount('math', '16', 16), true);
    assert.equal(matchesCount('math', ' 4 * 4 = 16 ', 16), true);
    assert.equal(matchesCount('math', '16=4*4', 16), true);
    assert.equal(matchesCount('math', '4*4=15', 16), false, 'both sides must agree');
    assert.equal(matchesCount('math', '4*4=16', 15), false);
    assert.equal(matchesCount('math', '16=16=16', 16), false);
    assert.equal(matchesCount('math', '=16', 16), false);
    assert.equal(matchesCount('math', '16=', 16), false);
    assert.equal(matchesCount('math', '33/2', 16), false, 'no rounding');
    assert.equal(matchesCount('math', '32/2', 16), true);
    assert.equal(matchesCount('math', 'sixteen', 16), false);
    assert.equal(matchesCount('math', '4*4 lol', 16), false);
});
