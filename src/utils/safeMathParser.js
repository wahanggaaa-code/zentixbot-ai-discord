// safeMathParser.js
//
// A small arithmetic evaluator with its own tokenizer; nothing is handed to the JavaScript engine.
// Every failure is a MathError with a `code`: SYNTAX, UNKNOWN_NAME (with `symbol`), NOT_FINITE, TOO_LONG.

export const MAX_EXPRESSION_LENGTH = 200;

export class MathError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MathError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const SUPPORTED_FUNCTIONS = Object.freeze({
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round
});

const SUPPORTED_CONSTANTS = Object.freeze({
  pi: Math.PI,
  e: Math.E
});

const OPERATOR_PRECEDENCE = Object.freeze({
  '^': 5,
  'u-': 4,
  '*': 3,
  '/': 3,
  '%': 3,
  '+': 2,
  '-': 2
});

const RIGHT_ASSOCIATIVE_OPERATORS = new Set(['^', 'u-']);

function normalizeExpression(input) {
  if (typeof input !== 'string') {
    throw new MathError('SYNTAX', 'Expression must be a string');
  }
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new MathError('TOO_LONG', 'Expression is too long');
  }

  return input
    .trim()
    .toLowerCase()
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt');
}

function preprocessDegrees(expression) {
  return expression.replace(/(\d+(?:\.\d+)?)\s*deg\b/g, '($1*pi/180)');
}

function isDigit(character) {
  return character >= '0' && character <= '9';
}

function isAlpha(character) {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character === '_';
}

function tokenize(expression) {
  const tokens = [];
  let index = 0;

  while (index < expression.length) {
    const character = expression[index];

    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }

    if (isDigit(character) || character === '.') {
      let numberText = '';
      let dotCount = 0;

      while (index < expression.length) {
        const current = expression[index];
        if (!isDigit(current) && current !== '.') {
          break;
        }

        if (current === '.') {
          dotCount += 1;
          if (dotCount > 1) {
            throw new MathError('SYNTAX', 'Invalid number format');
          }
        }

        numberText += current;
        index += 1;
      }

      if (numberText === '.' || numberText.length === 0) {
        throw new MathError('SYNTAX', 'Invalid number format');
      }

      // Scientific notation, the way results are shown: 1e21, 2.5e-3, 1E+6.
      const exponent = /^[eE][+-]?\d+/.exec(expression.slice(index));
      if (exponent) {
        numberText += exponent[0];
        index += exponent[0].length;
      }

      const value = Number(numberText);
      if (!Number.isFinite(value)) {
        throw new MathError('NOT_FINITE', 'Number is too large');
      }
      tokens.push({ type: 'number', value });
      continue;
    }

    if (isAlpha(character)) {
      let identifier = '';
      // A name starts with a letter and may go on with digits: log10, log2.
      while (index < expression.length && (isAlpha(expression[index]) || isDigit(expression[index]))) {
        identifier += expression[index];
        index += 1;
      }

      if (Object.prototype.hasOwnProperty.call(SUPPORTED_CONSTANTS, identifier)) {
        tokens.push({ type: 'number', value: SUPPORTED_CONSTANTS[identifier] });
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(SUPPORTED_FUNCTIONS, identifier)) {
        tokens.push({ type: 'function', value: identifier });
        continue;
      }

      throw new MathError('UNKNOWN_NAME', `Unsupported token: ${identifier}`, { symbol: identifier });
    }

    if ('+-*/%^()'.includes(character)) {
      if (character === '(') {
        tokens.push({ type: 'leftParen', value: character });
      } else if (character === ')') {
        tokens.push({ type: 'rightParen', value: character });
      } else {
        tokens.push({ type: 'operator', value: character });
      }

      index += 1;
      continue;
    }

    throw new MathError('SYNTAX', `Unsupported character: ${character}`);
  }

  return tokens;
}

function toRpn(tokens) {
  const output = [];
  const stack = [];
  let previousTokenType = null;

  for (const token of tokens) {
    if (token.type === 'number') {
      output.push(token);
      previousTokenType = 'number';
      continue;
    }

    if (token.type === 'function') {
      stack.push(token);
      previousTokenType = 'function';
      continue;
    }

    if (token.type === 'operator') {
      let operatorValue = token.value;

      if (operatorValue === '-' && (previousTokenType === null || previousTokenType === 'operator' || previousTokenType === 'leftParen' || previousTokenType === 'function')) {
        operatorValue = 'u-';
      }

      // A sign has no left operand, so it never completes an operator that came before it.
      while (operatorValue !== 'u-' && stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.type !== 'operator') {
          break;
        }

        const currentPrecedence = OPERATOR_PRECEDENCE[operatorValue];
        const topPrecedence = OPERATOR_PRECEDENCE[top.value];
        const isRightAssociative = RIGHT_ASSOCIATIVE_OPERATORS.has(operatorValue);

        if ((isRightAssociative && currentPrecedence < topPrecedence) || (!isRightAssociative && currentPrecedence <= topPrecedence)) {
          output.push(stack.pop());
        } else {
          break;
        }
      }

      stack.push({ type: 'operator', value: operatorValue });
      previousTokenType = 'operator';
      continue;
    }

    if (token.type === 'leftParen') {
      stack.push(token);
      previousTokenType = 'leftParen';
      continue;
    }

    if (token.type === 'rightParen') {
      let hasOpeningParen = false;

      while (stack.length > 0) {
        const top = stack.pop();
        if (top.type === 'leftParen') {
          hasOpeningParen = true;
          break;
        }

        output.push(top);
      }

      if (!hasOpeningParen) {
        throw new MathError('SYNTAX', 'Mismatched parentheses');
      }

      if (stack.length > 0 && stack[stack.length - 1].type === 'function') {
        output.push(stack.pop());
      }

      previousTokenType = 'rightParen';
    }
  }

  while (stack.length > 0) {
    const top = stack.pop();
    if (top.type === 'leftParen' || top.type === 'rightParen') {
      throw new MathError('SYNTAX', 'Mismatched parentheses');
    }
    output.push(top);
  }

  return output;
}

function evaluateRpn(rpnTokens) {
  const stack = [];

  for (const token of rpnTokens) {
    if (token.type === 'number') {
      stack.push(token.value);
      continue;
    }

    if (token.type === 'operator') {
      if (token.value === 'u-') {
        if (stack.length < 1) {
          throw new MathError('SYNTAX', 'Invalid expression');
        }
        stack.push(-stack.pop());
        continue;
      }

      if (stack.length < 2) {
        throw new MathError('SYNTAX', 'Invalid expression');
      }

      const right = stack.pop();
      const left = stack.pop();

      if (token.value === '+') stack.push(left + right);
      else if (token.value === '-') stack.push(left - right);
      else if (token.value === '*') stack.push(left * right);
      else if (token.value === '/') stack.push(left / right);
      else if (token.value === '%') stack.push(left % right);
      else if (token.value === '^') stack.push(Math.pow(left, right));
      else throw new MathError('SYNTAX', `Unsupported operator: ${token.value}`);

      continue;
    }

    if (token.type === 'function') {
      if (stack.length < 1) {
        throw new MathError('SYNTAX', 'Invalid function usage');
      }

      const value = stack.pop();
      const handler = SUPPORTED_FUNCTIONS[token.value];
      if (!handler) {
        throw new MathError('SYNTAX', `Unsupported function: ${token.value}`);
      }
      stack.push(handler(value));
      continue;
    }
  }

  if (stack.length !== 1) {
    throw new MathError('SYNTAX', 'Invalid expression');
  }

  return stack[0];
}

export function evaluateMathExpression(expression) {
  const normalized = preprocessDegrees(normalizeExpression(expression));
  const tokens = tokenize(normalized);
  const rpn = toRpn(tokens);
  const value = evaluateRpn(rpn);

  if (!Number.isFinite(value)) {
    throw new MathError('NOT_FINITE', 'Expression result is not finite');
  }

  return value;
}