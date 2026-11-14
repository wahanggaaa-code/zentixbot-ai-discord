/**
 * Request limits per client address for the built-in web server.
 *
 * Three budgets are counted separately, so that browsing the dashboard cannot use up the login
 * attempts and the other way round:
 *
 * - `login`: /dashboard/login and /dashboard/callback. Each login reserves a pending state on the
 *   server and may call Discord, so it stays tight.
 * - `dashboard`: everything else under /dashboard. Opening the page once fetches about thirty
 *   files that are never cached, and every tab reads its data afterwards, so this one is wide.
 * - `general`: all other paths (/, /health, /ready); its numbers come from the bot configuration.
 */
export const WEB_RATE_LIMITS = Object.freeze({
    login: Object.freeze({ windowMs: 15 * 60 * 1000, max: 30 }),
    dashboard: Object.freeze({ windowMs: 60 * 1000, max: 600 }),
    general: Object.freeze({ windowMs: 15 * 60 * 1000, max: 100 }),
});

/**
 * Which budget a request path is counted against. Express matches paths without regard to letter
 * case or a trailing slash, so the same is done here; otherwise /dashboard/LOGIN would reach the
 * login route while being counted as an ordinary dashboard request.
 *
 * @returns {'login' | 'dashboard' | 'general'}
 */
export function webRateLimitBucket(path) {
    const normal = String(path).toLowerCase().replace(/\/+$/, '');
    if (normal === '/dashboard/login' || normal === '/dashboard/callback') return 'login';
    if (normal === '/dashboard' || normal.startsWith('/dashboard/')) return 'dashboard';
    return 'general';
}

/**
 * Counts requests per key in fixed windows: the first request of a key opens a window, and once
 * `max` requests were let through, further ones are refused until the window ends. Refused
 * requests do not prolong the wait. Keys whose window has ended are dropped once per window, so
 * memory is bounded by the number of distinct keys seen within two windows.
 */
export function createFixedWindowCounter({ windowMs, max, now = Date.now }) {
    const windows = new Map();
    let nextSweep = now() + windowMs;
    return {
        hit(key) {
            const time = now();
            if (time >= nextSweep) {
                for (const [k, w] of windows) if (w.resetAt <= time) windows.delete(k);
                nextSweep = time + windowMs;
            }
            let window = windows.get(key);
            if (!window || window.resetAt <= time) {
                window = { count: 0, resetAt: time + windowMs };
                windows.set(key, window);
            }
            if (window.count >= max) return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - time) / 1000) };
            window.count += 1;
            return { allowed: true, retryAfterSeconds: 0 };
        },
        get size() { return windows.size; },
    };
}

const usable = (limit, fallback) => ({
    windowMs: Number.isFinite(limit?.windowMs) && limit.windowMs > 0 ? limit.windowMs : fallback.windowMs,
    max: Number.isInteger(limit?.max) && limit.max > 0 ? limit.max : fallback.max,
});

const waitText = (seconds) => (seconds < 60 ? `${seconds} detik` : `${Math.ceil(seconds / 60)} menit`);

/**
 * Express middleware applying the three budgets. A refused request gets status 429 with a
 * Retry-After header; under /dashboard the body says in Indonesian how long to wait, as JSON for
 * API paths (the pages show its `error` field) and as plain text otherwise.
 */
export function createWebRateLimit({ general, login, dashboard, now = Date.now } = {}) {
    const counters = {
        general: createFixedWindowCounter({ ...usable(general, WEB_RATE_LIMITS.general), now }),
        login: createFixedWindowCounter({ ...usable(login, WEB_RATE_LIMITS.login), now }),
        dashboard: createFixedWindowCounter({ ...usable(dashboard, WEB_RATE_LIMITS.dashboard), now }),
    };
    return (req, res, next) => {
        const bucket = webRateLimitBucket(req.path);
        const verdict = counters[bucket].hit(req.ip || 'unknown');
        if (verdict.allowed) return next();
        res.set('Retry-After', String(verdict.retryAfterSeconds));
        if (bucket === 'general') return res.status(429).json({ error: 'Too many requests' });
        const message = bucket === 'login'
            ? `Terlalu banyak percobaan login dari alamat ini. Coba lagi dalam ${waitText(verdict.retryAfterSeconds)}.`
            : `Terlalu banyak permintaan ke dashboard dari alamat ini. Coba lagi dalam ${waitText(verdict.retryAfterSeconds)}.`;
        if (req.path.toLowerCase().startsWith('/dashboard/api/')) return res.status(429).json({ error: message });
        return res.status(429).type('text/plain').send(message);
    };
}
