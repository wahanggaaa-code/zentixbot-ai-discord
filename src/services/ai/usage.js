// The AI usage report: how many AI requests were made per day, of which kind and by whom.
// One small record per server per UTC day (the daily quota also resets at 00:00 UTC), kept for 45 days.
// Only counters and member IDs are stored; no message text.

const KEEP_SECONDS = 45 * 24 * 3600;
const MAX_MEMBERS = 300;
export const MAX_REPORT_DAYS = 30;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const counters = (value, keyOk) => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([k, v]) => keyOk(k) && count(v) > 0));
const KIND = /^[a-z][a-z-]{1,23}$/;
const MEMBER = /^(\d{17,20}|other)$/;

/** A stored day as clean counters. Never throws. */
export function sanitizeDay(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { calls: count(v.calls), tokens: count(v.tokens), cacheHits: count(v.cacheHits), faqHits: count(v.faqHits), kinds: counters(v.kinds, (k) => KIND.test(k)), members: counters(v.members, (k) => MEMBER.test(k)) };
}

/**
 * `enabled()` resolves to the switch of the report; nothing is written while it is off.
 * `record` never throws: a counter that could not be written must not cost a member the answer.
 */
export function createUsage({ kv, now = Date.now, enabled = async () => true }) {
    const key = (guildId, day) => `ai:usage:day:${guildId}:${day}`;
    async function write(guildId, change) {
        try {
            if (!(await enabled())) return false;
            await kv.update(key(guildId, dayOf(now())), (current) => { const day = sanitizeDay(current); change(day); return day; }, KEEP_SECONDS);
            return true;
        } catch { return false; }
    }
    return {
        /** One AI request that was answered by a provider. */
        record({ guildId, userId = null, kind = 'other', tokens = 0 }) {
            const name = KIND.test(String(kind)) ? kind : 'other';
            return write(guildId, (day) => {
                day.calls += 1;
                day.tokens += count(Math.round(Number(tokens)));
                day.kinds[name] = (day.kinds[name] ?? 0) + 1;
                if (typeof userId === 'string' && /^\d{17,20}$/.test(userId)) {
                    const slot = Object.hasOwn(day.members, userId) || Object.keys(day.members).length < MAX_MEMBERS ? userId : 'other';
                    day.members[slot] = (day.members[slot] ?? 0) + 1;
                }
            });
        },
        /** An answer that needed no AI request: 'cache' or 'faq'. */
        saved({ guildId, how }) {
            return write(guildId, (day) => { if (how === 'faq') day.faqHits += 1; else day.cacheHits += 1; });
        },
        /** The last `days` days, oldest first, with totals per kind and the five busiest members. */
        async report(guildId, days = 7) {
            const span = Math.min(Math.max(Number.isInteger(days) ? days : 7, 1), MAX_REPORT_DAYS);
            const list = [];
            for (let i = span - 1; i >= 0; i--) {
                const day = dayOf(now() - i * 86400000);
                list.push({ day, ...sanitizeDay(await kv.get(key(guildId, day))) });
            }
            const total = { calls: 0, tokens: 0, cacheHits: 0, faqHits: 0 }, kinds = {}, members = {};
            for (const day of list) {
                for (const name of Object.keys(total)) total[name] += day[name];
                for (const [k, v] of Object.entries(day.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
                for (const [k, v] of Object.entries(day.members)) members[k] = (members[k] ?? 0) + v;
            }
            const ranked = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            return {
                days: list.map(({ day, calls, tokens, cacheHits, faqHits }) => ({ day, calls, tokens, cacheHits, faqHits })),
                total,
                kinds: ranked(kinds).map(([kind, calls]) => ({ kind, calls })),
                members: ranked(members).filter(([id]) => id !== 'other').slice(0, 5).map(([userId, calls]) => ({ userId, calls })),
            };
        },
    };
}
