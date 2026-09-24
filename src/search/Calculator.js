/*
 * Safe calculator grammar adapted from Rudra by NarkAgni.
 * Copyright (C) 2026 NarkAgni
 * Copyright (C) 2026 GDI contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function _evaluate(expression) {
  const tokens = [];
  const tokenPattern = /(\d+\.?\d*|\.\d+|[+\-*\/%^()])/g;
  let match;
  let previousEnd = 0;
  while ((match = tokenPattern.exec(expression)) !== null) {
    if (match.index !== previousEnd)
      return null;
    tokens.push(match[1]);
    previousEnd = tokenPattern.lastIndex;
  }
  if (previousEnd !== expression.length)
    return null;

  let position = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const parseExpression = () => parseAddSub();

  function parseAddSub() {
    let left = parseMulDiv();
    if (left === null)
      return null;
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = parseMulDiv();
      if (right === null)
        return null;
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePower();
    if (left === null)
      return null;
    while (['*', '/', '%'].includes(peek())) {
      const operator = consume();
      const right = parsePower();
      if (right === null || ((operator === '/' || operator === '%') && right === 0))
        return null;
      if (operator === '*')
        left *= right;
      else if (operator === '/')
        left /= right;
      else
        left %= right;
    }
    return left;
  }

  function parsePower() {
    const base = parseUnary();
    if (base === null)
      return null;
    if (peek() === '^') {
      consume();
      const exponent = parsePower();
      return exponent === null ? null : Math.pow(base, exponent);
    }
    return base;
  }

  function parseUnary() {
    if (peek() === '-') {
      consume();
      const value = parseUnary();
      return value === null ? null : -value;
    }
    if (peek() === '+') {
      consume();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (token === '(') {
      consume();
      const value = parseExpression();
      if (peek() !== ')')
        return null;
      consume();
      return value;
    }
    if (token !== undefined && /^(\d+\.?\d*|\.\d+)$/.test(token)) {
      consume();
      return Number.parseFloat(token);
    }
    return null;
  }

  const result = parseExpression();
  return position === tokens.length ? result : null;
}

export function calculateExpression(query) {
  const expression = query.trim();
  if (expression.length > 120 ||
      !/^[\d\s+\-*\/%().^]+$/.test(expression) ||
      !/[+\-*\/%^]/.test(expression))
    return null;

  const result = _evaluate(expression.replace(/\s+/g, ''));
  if (result === null || !Number.isFinite(result))
    return null;
  return Math.round(result * 1e10) / 1e10;
}
