const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const SWITCH_ON = ['true', '1'];

/** Whether plain HTTP on a public address was switched on by the operator. */
export const httpAllowed = (env) => SWITCH_ON.includes(String(env?.DASHBOARD_ALLOW_HTTP ?? '').trim().toLowerCase());

/**
 * The address the dashboard is reached at, read from DASHBOARD_URL.
 *
 * https is accepted on any host and plain http on localhost. Plain http on any other host carries
 * the login session unencrypted, so it is accepted only when DASHBOARD_ALLOW_HTTP is switched on;
 * `insecure` is true in exactly that case.
 *
 * @returns {{ origin: string | null, insecure: boolean, reason: null | 'missing' | 'malformed' | 'http_not_allowed' }}
 */
export function resolveDashboardOrigin(env) {
    const raw = String(env?.DASHBOARD_URL ?? '').trim();
    if (!raw) return { origin: null, insecure: false, reason: 'missing' };
    let url;
    try {
        url = new URL(raw);
    } catch {
        return { origin: null, insecure: false, reason: 'malformed' };
    }
    const plain = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    if (!plain || (url.protocol !== 'https:' && url.protocol !== 'http:')) return { origin: null, insecure: false, reason: 'malformed' };
    if (url.protocol === 'https:' || LOCAL_HOSTS.includes(url.hostname)) return { origin: url.origin, insecure: false, reason: null };
    if (!httpAllowed(env)) return { origin: null, insecure: false, reason: 'http_not_allowed' };
    return { origin: url.origin, insecure: true, reason: null };
}

/**
 * The dashboard address together with whether a Discord login can work: that needs a usable
 * address, the application's id and secret, and the home server.
 */
export function dashboardLoginStatus(env, homeGuildId) {
    const address = resolveDashboardOrigin(env);
    const credentials = /^\d{17,20}$/.test(env?.CLIENT_ID || '') && Boolean(env?.DISCORD_CLIENT_SECRET) && Boolean(homeGuildId);
    return { ...address, configured: Boolean(address.origin && credentials) };
}

/** What to tell someone who opens a dashboard whose login cannot work yet. */
export function notConfiguredMessage(reason) {
    if (reason === 'http_not_allowed') {
        return 'Login belum dikonfigurasi: DASHBOARD_URL memakai http:// pada alamat publik. Pakai alamat https://, atau atur DASHBOARD_ALLOW_HTTP=true bila hosting hanya menyediakan HTTP (sesi login lalu tidak terenkripsi).';
    }
    if (reason === 'malformed') {
        return 'Login belum dikonfigurasi: DASHBOARD_URL harus berupa alamat saja, misalnya https://bot.example.com atau http://203.0.113.5:16954, tanpa path, tanda tanya atau nama pengguna.';
    }
    return 'Login belum dikonfigurasi. Cara termudah: isi DASHBOARD_TOKEN (minimal 12 karakter) dan OWNER_IDS, lalu restart bot. Login lewat Discord juga bisa. Atur CLIENT_ID, DISCORD_CLIENT_SECRET, DASHBOARD_URL dan GUILD_ID.';
}
