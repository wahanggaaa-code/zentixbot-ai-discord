import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsFixture } from './helpers/tools-fixture.js';
import { evaluateMathExpression, MathError, MAX_EXPRESSION_LENGTH } from '../src/utils/safeMathParser.js';
import calculate, { formatResult } from '../src/commands/Tools/calculate.js';
import calculatorButtons from '../src/interactions/buttons/calculate/calculate.js';
import calculatorModals from '../src/interactions/modals/calculate/calculate.js';

const failure = (expression) => {
    try {
        evaluateMathExpression(expression);
    } catch (error) {
        assert.ok(error instanceof MathError, `${expression}: ${error}`);
        return error.code;
    }
    return 'no error';
};

function calculator() {
    const fx = createToolsFixture();
    fx.register('buttons', calculatorButtons);
    fx.register('modals', calculatorModals);
    return fx;
}

test('parser: precedence, functions and constants', () => {
    const cases = [
        ['2+2*3', 8], ['(2+2)*3', 12], ['10 % 3', 1], ['2^10', 1024], ['2^3^2', 512],
        // A minus in front applies to the whole power, as on paper.
        ['-2^2', -4], ['(-2)^2', 4], ['2^-1', 0.5], ['2*-3', -6], ['--2', 2], ['2 - -2', 4],
        ['sqrt(16)', 4], ['abs(-3)', 3], ['log10(100)', 2], ['log2(8)', 3], ['ln(e)', 1], ['exp(0)', 1],
        ['1e5', 100000], ['2.5e-3', 0.0025], ['1E+21', 1e21], ['3e2+1', 301], ['2*e', 2 * Math.E],
        ['floor(2.7)', 2], ['ceil(2.1)', 3], ['round(2.5)', 3], ['sin(0)', 0], ['pi', Math.PI],
    ];
    for (const [expression, expected] of cases) assert.equal(evaluateMathExpression(expression), expected, expression);
    assert.ok(Math.abs(evaluateMathExpression('sin(90 deg)') - 1) < 1e-12);
});

test('parser: every failure says what kind it is', () => {
    assert.equal(failure('1/0'), 'NOT_FINITE');
    assert.equal(failure('sqrt(-1)'), 'NOT_FINITE');
    assert.equal(failure('9^9^9'), 'NOT_FINITE');
    // A number too large to hold is refused where it stands, not after it has turned into 0.
    assert.equal(failure('1/1e999'), 'NOT_FINITE');
    assert.equal(failure('5!'), 'SYNTAX');
    assert.equal(failure('2(3)'), 'SYNTAX');
    assert.equal(failure('1.5.2'), 'SYNTAX');
    assert.equal(failure('2+'), 'SYNTAX');
    assert.equal(failure('2e'), 'SYNTAX');
    assert.equal(failure('1e-00001 1'), 'SYNTAX');
    assert.equal(failure('1e999'), 'NOT_FINITE');
    assert.equal(failure('(2+3'), 'SYNTAX');
    assert.equal(failure(''), 'SYNTAX');
    assert.equal(failure('   '), 'SYNTAX');
    assert.equal(failure('foo(2)'), 'UNKNOWN_NAME');
    assert.equal(failure('process'), 'UNKNOWN_NAME');
    assert.equal(failure('1+'.repeat(MAX_EXPRESSION_LENGTH)), 'TOO_LONG');
    assert.equal(failure(`${'1'.repeat(MAX_EXPRESSION_LENGTH)}`), 'no error');
    assert.equal(failure(`${'1'.repeat(MAX_EXPRESSION_LENGTH + 1)}`), 'TOO_LONG');
});

test('results keep their digits', () => {
    assert.equal(formatResult(12345678902), '12,345,678,902');
    assert.equal(formatResult(0.1 + 0.2), '0.3');
    assert.equal(formatResult(2 ** 0.5), '1.4142135624');
    assert.equal(formatResult(-0), '0');
    assert.equal(formatResult(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991');
    assert.equal(formatResult(1e21), '1e+21');
    assert.equal(formatResult(1.5e-9), '1.5e-9');
    assert.equal(formatResult(-2.5), '-2.5');
});

test('/calculate answers with the result and tells the kinds of failure apart', async () => {
    const fx = calculator();
    const ask = async (expression) => fx.run(calculate, fx.slash(fx.alice, { expression }));

    const ok = await ask('12345678901+1');
    assert.match(ok.said(), /Calculation Result/);
    assert.match(ok.said(), /`12345678901\+1`/);
    assert.match(ok.said(), /`12,345,678,902`/);
    assert.equal(fx.calls.collectors.length, 0, 'no collector is created');

    assert.match((await ask('-2^2')).said(), /`-4`/);
    assert.equal((await ask('5/2')).buttonIds()[3], `calc:op:divide:${fx.alice.id}:2.5`, 'the button carries the exact result');
    assert.match((await ask('log10(100)')).said(), /Result:\*\* `2`/);

    const zero = (await ask('1/0')).said();
    const unknown = (await ask('foo(2)')).said();
    const syntax = (await ask('5!')).said();
    assert.match(zero, /not a finite number/);
    assert.match(zero, /division by zero/);
    assert.match(unknown, /I do not know `foo`/);
    assert.match(syntax, /could not read that expression/);
    assert.equal(new Set([zero, unknown, syntax]).size, 3);
    for (const said of [zero, unknown, syntax]) assert.doesNotMatch(said, /Calculation Result/);
});

test('/calculate works where there is no channel object', async () => {
    const fx = calculator();
    const out = await fx.run(calculate, fx.slash(fx.alice, { expression: '2*3*4' }, { channel: null }));
    assert.equal(out.replies.length, 1);
    assert.match(out.said(), /`24`/);
});

test('the buttons continue from the result, in the same message, and carry the result forward', async () => {
    const fx = calculator();
    const first = await fx.run(calculate, fx.slash(fx.alice, { expression: '2*3*4' }));
    const [add] = first.buttonIds();
    assert.equal(add, `calc:op:add:${fx.alice.id}:24`);
    assert.equal(first.buttonIds().length, 4);

    const press = await fx.route(fx.button(fx.alice, add, { message: first.message }));
    assert.equal(press.modals.length, 1);
    assert.equal(press.modals[0].custom_id, 'calc:apply:add:24');
    assert.equal(press.modals[0].components[0].components[0].custom_id, 'operand');
    assert.equal(press.replies.length, 0);

    const pressTimes = await fx.route(fx.button(fx.alice, first.buttonIds()[2], { message: first.message }));
    assert.equal(pressTimes.modals[0].custom_id, 'calc:apply:multiply:24');
    assert.equal(pressTimes.modals[0].components[0].components[0].label, 'Number to multiply by');

    const form = await fx.route(fx.modal(fx.alice, 'calc:apply:add:24', { operand: '5' }, { message: first.message }));
    assert.equal(form.replies.at(-1).method, 'update', 'the result replaces the old one; no new message');
    assert.match(form.said(), /`24 \+ \(5\)`/);
    assert.match(form.said(), /Result:\*\* `29`/);
    // The next step starts from 29, not from the first expression again.
    const [nextAdd, , multiply] = form.buttonIds();
    assert.equal(nextAdd, `calc:op:add:${fx.alice.id}:29`);

    const again = await fx.route(fx.modal(fx.alice, 'calc:apply:multiply:29', { operand: 'sqrt(4)' }, { message: first.message }));
    assert.match(again.said(), /Result:\*\* `58`/);
    assert.equal(multiply, `calc:op:multiply:${fx.alice.id}:29`);
    assert.equal(fx.calls.collectors.length, 0);
});

test('only the member who calculated can continue; the answer to anyone else is private', async () => {
    const fx = calculator();
    const press = await fx.route(fx.button(fx.bob, `calc:op:add:${fx.alice.id}:24`));
    assert.equal(press.modals.length, 0);
    assert.match(press.said(), /Only the member who ran this calculation/);
    assert.equal(press.isPrivate(), true);
});

test('a bad number in the form is explained and changes nothing', async () => {
    const fx = calculator();
    const message = fx.makeMessage(fx.general);
    for (const [operation, operand, expected] of [
        ['divide', '0', /not a finite number/],
        ['add', ' ', /could not read/],
        ['add', '0x10', /I do not know `x10`/],
        ['add', 'Infinity', /I do not know `infinity`/],
        ['multiply', '1e308*10', /not a finite number/],
        ['add', '1e999', /not a finite number/],
    ]) {
        const form = await fx.route(fx.modal(fx.alice, `calc:apply:${operation}:24`, { operand }, { message }));
        assert.match(form.said(), expected, `${operation} ${operand}`);
        assert.equal(form.replies.at(-1).method, 'reply');
        assert.equal(form.isPrivate(), true);
    }
    const overflow = await fx.route(fx.modal(fx.alice, 'calc:apply:multiply:1e+308', { operand: '100' }, { message }));
    assert.match(overflow.said(), /not a finite number/);
});

test('ids this bot did not write are refused', async () => {
    const fx = calculator();
    for (const id of [
        `calc:op:power:${fx.alice.id}:24`, `calc:op:add:${fx.alice.id}:abc`, `calc:op:add:${fx.alice.id}:Infinity`,
        `calc:op:add:${fx.alice.id}`, `calc:op:constructor:${fx.alice.id}:1`, `calc:nope:add:${fx.alice.id}:1`,
    ]) {
        const press = await fx.route(fx.button(fx.alice, id));
        assert.equal(press.modals.length, 0, id);
        assert.match(press.said(), /no longer valid/, id);
    }
    for (const id of ['calc:apply:power:24', 'calc:apply:add:1e999', 'calc:apply:add:NaN', 'calc:apply:add', 'calc:other:add:1']) {
        const form = await fx.route(fx.modal(fx.alice, id, { operand: '1' }));
        assert.match(form.said(), /no longer valid/, id);
    }
});

test('large and small results survive the trip through the button', async () => {
    const fx = calculator();
    const big = await fx.run(calculate, fx.slash(fx.alice, { expression: '10^21' }));
    assert.equal(big.buttonIds()[0], `calc:op:add:${fx.alice.id}:1e+21`);
    const form = await fx.route(fx.modal(fx.alice, 'calc:apply:divide:1e+21', { operand: '10^21' }, { message: big.message }));
    assert.match(form.said(), /Result:\*\* `1`/);
    const negative = await fx.route(fx.modal(fx.alice, 'calc:apply:subtract:-2.5', { operand: '0.5' }, { message: big.message }));
    assert.match(negative.said(), /Result:\*\* `-3`/);
    for (const id of big.buttonIds()) assert.ok(id.length <= 100);
});
