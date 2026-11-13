import axios from 'axios';
import { escapeMarkdown } from 'discord.js';

/**
 * Shared pieces of the /search commands: one way to ask a public JSON service, and two ways to
 * put text that the bot did not write (a member's input, a service's answer) into an embed.
 */

export const LOOKUP_TIMEOUT_MS = 5_000;
/** Hard stop for the whole request; axios `timeout` alone does not cover a stalled connection. */
export const LOOKUP_DEADLINE_MS = 8_000;
export const LOOKUP_MAX_BYTES = 512 * 1024;

/** Why a lookup produced no usable answer. */
export const LookupFailure = Object.freeze({
    NOT_FOUND: 'not_found',
    RATE_LIMITED: 'rate_limited',
    UNREACHABLE: 'unreachable',
    BAD_RESPONSE: 'bad_response',
});

export class LookupError extends Error {
    constructor(kind, { status = null, cause = null } = {}) {
        super(`lookup ${kind}${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'LookupError';
        this.kind = kind;
        this.status = status;
        this.reason = cause?.code ?? cause?.message ?? null;
    }
}

/**
 * GET a JSON document. Returns the parsed object or array, or throws a LookupError.
 * Nothing else is thrown for a failed request. The second argument exists for tests.
 */
export async function getJson(url, { timeoutMs = LOOKUP_TIMEOUT_MS, deadlineMs = LOOKUP_DEADLINE_MS, maxBytes = LOOKUP_MAX_BYTES } = {}) {
    let response;
    try {
        response = await axios.get(url, {
            timeout: timeoutMs,
            signal: AbortSignal.timeout(deadlineMs),
            maxContentLength: maxBytes,
            maxRedirects: 2,
            responseType: 'json',
            headers: { Accept: 'application/json' },
        });
    } catch (error) {
        const status = error?.response?.status ?? null;
        if (status === 404) throw new LookupError(LookupFailure.NOT_FOUND, { status });
        if (status === 429) throw new LookupError(LookupFailure.RATE_LIMITED, { status });
        if (status) throw new LookupError(LookupFailure.BAD_RESPONSE, { status });
        // The service answered, but with more than we are willing to read.
        if (/maxContentLength/i.test(String(error?.message))) {
            throw new LookupError(LookupFailure.BAD_RESPONSE, { cause: error });
        }
        throw new LookupError(LookupFailure.UNREACHABLE, { cause: error });
    }
    const data = response?.data;
    if (data === null || typeof data !== 'object') {
        throw new LookupError(LookupFailure.BAD_RESPONSE, { status: response?.status ?? null });
    }
    return data;
}

/** The message a member sees for a failed lookup; `service` is how the service is called in a sentence. */
export function lookupFailureMessage(error, service) {
    switch (error?.kind) {
        case LookupFailure.RATE_LIMITED:
            return `${service} is receiving too many requests. Please try again in a few minutes.`;
        case LookupFailure.UNREACHABLE:
            return `${service} could not be reached. Please try again later.`;
        default:
            return `${service} did not give a usable answer. Please try again later.`;
    }
}

// Control characters except newline; they have no place in an embed.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

function cut(text, limit) {
    if (text.length <= limit) return text;
    let kept = text.slice(0, Math.max(0, limit - 1));
    // Do not leave half of a surrogate pair or an escape without its character.
    if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
    const trailing = /\\+$/.exec(kept)?.[0].length ?? 0;
    if (trailing % 2 === 1) kept = kept.slice(0, -1);
    return `${kept}…`;
}

/**
 * Text from outside, shown as ordinary text: markdown and masked links are escaped, so the text
 * cannot format itself or hide a link behind other words. Never longer than `limit`.
 */
export function plainText(value, limit) {
    if (typeof value !== 'string') return '';
    const cleaned = value.replace(CONTROL, ' ').trim();
    return cut(escapeMarkdown(cleaned, { maskedLink: true, heading: true }), limit);
}

/**
 * A member's own input, echoed back inside a code span. Discord renders nothing inside one:
 * no markdown, no links, no mentions. Never longer than `limit` plus the two backticks.
 */
export function codeSpan(value, limit = 100) {
    const cleaned = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/`/g, "'").replace(/ {2,}/g, ' ').trim();
    return `\`${cut(cleaned, limit) || ' '}\``;
}

/** encodeURIComponent, plus the five characters it leaves alone; `)` would end a markdown link early. */
export function encodeQuery(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
