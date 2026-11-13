// systems.js — the number systems of the counting game.
//
// Each system writes a number its own way (`format`) and decides whether a
// member's message is that number (`matches`). Nothing here evaluates code:
// the "math" system is read by a small parser for + - * / ** ^ and brackets.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ROMAN = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90],
    ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1],
];

function toBase64(n) {
    if (n === 0) return 'A';
    let value = n;
    let result = '';
    while (value > 0) {
        result = BASE64[value % 64] + result;
        value = Math.floor(value / 64);
    }
    return result;
}

function toRoman(n) {
    let rest = n;
    let result = '';
    for (const [letters, value] of ROMAN) {
        if (rest >= value) {
            const times = Math.floor(rest / value);
            result += letters.repeat(times);
            rest -= times * value;
        }
    }
    return result;
}

function toLetters(n) {
    let rest = n;
    let result = '';
    while (rest > 0) {
        rest -= 1;
        result = String.fromCharCode(65 + (rest % 26)) + result;
        rest = Math.floor(rest / 26);
    }
    return result;
}

const MAX_EXPRESSION = 200;
const MAX_DEPTH = 40;

/**
 * The value of an arithmetic expression, or `null` when the text is not one.
 * Numbers, + - * /, ** or ^ (right to left), brackets and a leading sign.
 */
export function evaluateExpression(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_EXPRESSION) return null;
    if (!/^[0-9+\-*/().^]+$/.test(text)) return null;
    let at = 0;
    let depth = 0;
    const peek = () => text[at];
    const take = (symbol) => {
        if (!text.startsWith(symbol, at)) return false;
        at += symbol.length;
        return true;
    };

    function primary() {
        if (take('(')) {
            if (++depth > MAX_DEPTH) throw new Error('too deep');
            const value = sum();
            if (!take(')')) throw new Error('bracket');
            depth -= 1;
            return value;
        }
        const match = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(at));
        if (!match) throw new Error('number');
        at += match[0].length;
        return Number(match[0]);
    }
    function power() {
        const base = primary();
        if (take('**') || take('^')) return base ** signed();
        return base;
    }
    function signed() {
        if (++depth > MAX_DEPTH) throw new Error('too deep');
        let value;
        if (take('-')) value = -signed();
        else if (take('+')) value = signed();
        else value = power();
        depth -= 1;
        return value;
    }
    function product() {
        let value = signed();
        for (;;) {
            // `**` belongs to power(); a lone `*` is a multiplication.
            if (peek() === '*' && text[at + 1] !== '*') { at += 1; value *= signed(); }
            else if (take('/')) value /= signed();
            else return value;
        }
    }
    function sum() {
        let value = product();
        for (;;) {
            if (take('+')) value += product();
            else if (take('-')) value -= product();
            else return value;
        }
    }

    try {
        const value = sum();
        if (at !== text.length || !Number.isFinite(value)) return null;
        return value;
    } catch {
        return null;
    }
}

/** `4*4` or `4*4=16`: the value both sides agree on, or `null`. */
function evaluateEquation(content) {
    const text = content.replace(/\s+/g, '');
    const sides = text.split('=');
    if (sides.length > 2) return null;
    const left = evaluateExpression(sides[0]);
    if (left === null) return null;
    if (sides.length === 1) return left;
    return evaluateExpression(sides[1]) === left ? left : null;
}

const exact = (format) => (text, n) => text === format(n);
const anyCase = (format) => (text, n) => text.toUpperCase() === format(n);

export const COUNTING_SYSTEMS = {
    decimal: {
        label: 'Decimal',
        description: 'Standard numbers: 1, 2, 3',
        format: (n) => n.toString(10),
        matches: exact((n) => n.toString(10)),
    },
    hexadecimal: {
        label: 'Hexadecimal',
        description: 'Base 16 using 0-9 and A-F, upper or lower case',
        format: (n) => n.toString(16).toUpperCase(),
        matches: anyCase((n) => n.toString(16).toUpperCase()),
    },
    binary: {
        label: 'Binary',
        description: 'Base 2 using 0 and 1',
        format: (n) => n.toString(2),
        matches: exact((n) => n.toString(2)),
    },
    base36: {
        label: 'Base36',
        description: 'Base 36 using 0-9 and A-Z, upper or lower case',
        format: (n) => n.toString(36).toUpperCase(),
        matches: anyCase((n) => n.toString(36).toUpperCase()),
    },
    base64: {
        label: 'Base64',
        description: 'Base 64 digits A-Z, a-z, 0-9, + and /; the count starts at B',
        format: toBase64,
        matches: exact(toBase64),
    },
    roman: {
        label: 'Roman',
        description: 'Roman numerals: I, II, III, IV, V',
        format: toRoman,
        matches: anyCase(toRoman),
    },
    math: {
        label: 'Math Expressions',
        description: 'A calculation that equals the next number, like 4*4 or 4*4=16',
        format: (n) => `${n}`,
        matches: (text, n) => evaluateEquation(text) === n,
    },
    alphabet: {
        label: 'Alphabet',
        description: 'Letters in sequence: A, B, … Z, AA, AB',
        format: toLetters,
        matches: anyCase(toLetters),
    },
};

export const isCountingSystem = (key) => typeof key === 'string' && Object.hasOwn(COUNTING_SYSTEMS, key);
export const systemOf = (key) => COUNTING_SYSTEMS[isCountingSystem(key) ? key : 'decimal'];

/** How the number `n` is written in a system. */
export const formatCount = (system, n) => systemOf(system).format(n);

/** Is `content` the number `n` in this system? Surrounding spaces do not matter. */
export function matchesCount(system, content, n) {
    if (typeof content !== 'string') return false;
    const text = content.trim();
    if (!text) return false;
    return systemOf(system).matches(text, n) === true;
}
