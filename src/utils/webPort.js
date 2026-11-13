/**
 * Which port the web server (health endpoints and dashboard) listens on.
 *
 * Hosting panels hand the allocated port over under different names, so the first usable value of
 * these is taken, in this order. `SERVER_PORT` is what Pterodactyl-style panels set by themselves.
 */
export const WEB_PORT_VARIABLES = Object.freeze(['WEB_PORT', 'PORT', 'SERVER_PORT']);
export const DEFAULT_WEB_PORT = 3000;

/**
 * @returns {{ port: number, source: string | null, ignored: string[] }} `source` is the variable the
 * port came from (null for the default); `ignored` lists variables that were set to something that
 * is not a port (empty, `0` and unset count as "not set" and are not listed).
 */
export function resolveWebPort(env = process.env) {
    const ignored = [];
    for (const name of WEB_PORT_VARIABLES) {
        const raw = String(env?.[name] ?? '').trim();
        if (raw === '' || raw === '0') continue;
        const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
        if (port >= 1 && port <= 65535) return { port, source: name, ignored };
        ignored.push(name);
    }
    return { port: DEFAULT_WEB_PORT, source: null, ignored };
}
