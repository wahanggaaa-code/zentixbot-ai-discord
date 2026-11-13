import { BotConfig } from '../../config/bot.js';

// Currency display settings are stored per server in the guild configuration
// (key `economyCurrency`). They are never written into source files.

const SYMBOL = /^[\p{L}\p{N}\p{Sc}\p{Extended_Pictographic}]+$/u;
const NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} -]*[\p{L}\p{N}])?$/u;
const length = (text) => [...text].length;

export const MAX_ADMIN_AMOUNT = 1_000_000_000_000;

/** Returns the symbol, or null when it is not 1-3 letters, digits, currency signs or emoji. */
export function parseCurrencySymbol(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    return length(value) >= 1 && length(value) <= 3 && SYMBOL.test(value) ? value : null;
}

/** Returns the name, or null when it is not 1-20 letters, digits, spaces or hyphens. */
export function parseCurrencyName(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    return length(value) >= 1 && length(value) <= 20 && NAME.test(value) ? value : null;
}

/** Stored currency of a server; anything unusable falls back to the defaults. */
export function getCurrency(guildConfig) {
    const stored = guildConfig?.economyCurrency;
    const defaults = BotConfig.economy?.currency ?? {};
    return {
        symbol: parseCurrencySymbol(stored?.symbol) ?? parseCurrencySymbol(defaults.symbol) ?? '$',
        name: parseCurrencyName(stored?.name) ?? parseCurrencyName(defaults.name) ?? 'coins',
    };
}

/**
 * Whole amount typed by an admin: digits only (no separators, so "1.000" is
 * never read as either 1 or 1000), from 1 to MAX_ADMIN_AMOUNT. Null otherwise.
 */
export function parseAdminAmount(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    if (!/^\d{1,13}$/.test(value)) return null;
    const amount = Number(value);
    return amount >= 1 && amount <= MAX_ADMIN_AMOUNT ? amount : null;
}
