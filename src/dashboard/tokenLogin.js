import crypto from 'node:crypto';

/**
 * Login to the dashboard with one secret from the environment, DASHBOARD_TOKEN, instead of going
 * through Discord. Whoever knows the token is the operator of the bot.
 *
 * The dashboard acts in Discord on behalf of an account (it moderates, hosts giveaways, closes
 * tickets), so a token login needs one: the first Discord user ID in OWNER_IDS.
 */
export const TOKEN_MIN_LENGTH = 12;
export const TOKEN_SESSION_MS = 12 * 60 * 60 * 1000;

const isUserId = (text) => /^\d{17,20}$/.test(text);

/**
 * @returns {{ enabled: boolean, reason: null | 'missing' | 'too_short' | 'no_owner', ownerId: string | null }}
 *          The token itself is never part of the result, so that the result can be logged.
 */
export function tokenLoginStatus(env) {
    const token = String(env?.DASHBOARD_TOKEN ?? '').trim();
    const ownerId = String(env?.OWNER_IDS ?? '').split(',').map((id) => id.trim()).find(isUserId) ?? null;
    if (!token) return { enabled: false, reason: 'missing', ownerId };
    if (token.length < TOKEN_MIN_LENGTH) return { enabled: false, reason: 'too_short', ownerId };
    if (!ownerId) return { enabled: false, reason: 'no_owner', ownerId };
    return { enabled: true, reason: null, ownerId };
}

const digest = (text) => crypto.createHash('sha256').update(text).digest();

/** Compares what was typed with DASHBOARD_TOKEN, in a time that does not depend on where they differ. */
export function tokenMatches(candidate, env) {
    const expected = String(env?.DASHBOARD_TOKEN ?? '').trim();
    if (typeof candidate !== 'string' || expected.length < TOKEN_MIN_LENGTH) return false;
    return crypto.timingSafeEqual(digest(candidate.trim()), digest(expected));
}

/**
 * The token carried by a login link, /dashboard/masuk/<token>.
 * @param {string} rest  the part of the path after "/masuk", e.g. "/my-token"
 * @returns {string | null} null when the link carries no token
 */
export function linkToken(rest) {
    const raw = String(rest ?? '').replace(/^\//, '');
    if (!raw) return null;
    try {
        return decodeURIComponent(raw);
    } catch {
        // Broken percent-encoding ("%ZZ"): taken as it stands, and it will not match.
        return raw;
    }
}

/** Why the token login is off, for someone who opens the login page. */
export function tokenOffMessage(reason) {
    if (reason === 'too_short') return `Login dengan token belum aktif: DASHBOARD_TOKEN harus minimal ${TOKEN_MIN_LENGTH} karakter.`;
    if (reason === 'no_owner') return 'Login dengan token belum aktif: isi OWNER_IDS dengan ID akun Discord kamu (17 sampai 20 angka). Dashboard bertindak atas nama akun itu.';
    return 'Login dengan token belum aktif: isi DASHBOARD_TOKEN dan OWNER_IDS.';
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The login page: one field for the token.
 * @param {object} [options]
 * @param {string} [options.error]     shown above the field
 * @param {boolean} [options.discord]  whether the Discord login is configured as well
 */
export function loginFormPage({ error = '', discord = false } = {}) {
    return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Masuk dashboard</title>'
        + '<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem;line-height:1.5}'
        + 'h1{font-size:1.25rem}label{display:block;margin-bottom:.35rem}'
        + 'input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:.4rem}'
        + 'input{border:1px solid #8888}button{margin-top:.8rem;border:0;background:#5865f2;color:#fff;cursor:pointer}'
        + '.error{padding:.6rem .7rem;border-radius:.4rem;border:1px solid #d33;margin-bottom:1rem}small{opacity:.75}</style></head><body>'
        + '<h1>Masuk dashboard</h1>'
        + (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '')
        + '<form method="post" action="/dashboard/login">'
        + '<label for="token">Token dashboard</label>'
        + '<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>'
        + '<button type="submit">Masuk</button></form>'
        + '<p><small>Token adalah isi <code>DASHBOARD_TOKEN</code> pada berkas <code>.env</code> bot.</small></p>'
        + (discord ? '<p><a href="/dashboard/login?via=discord">Masuk dengan akun Discord</a></p>' : '')
        + '</body></html>';
}
