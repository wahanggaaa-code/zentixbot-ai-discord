/**
 * GET /dashboard/api/bot/system-usage: CPU, memory, network and disk of the bot's host, for the
 * overview page. Bot owner only: the numbers describe the hosting, not the Discord server.
 *
 * The figures are measured inside the bot's container (src/services/systemUsage.js). When the
 * hosting panel's API is configured (HOSTING_PANEL_URL, HOSTING_SERVER_ID, HOSTING_API_KEY), the
 * panel is asked as well, at most every 15 seconds, for the two things it knows better: the
 * server's state and its disk use.
 */
import express from 'express';
import { createSystemUsage } from '../services/systemUsage.js';
import { botOwnerIds, hostingConfigured } from './settingsApi.js';

export const PANEL_REFRESH_MS = 15 * 1000;

const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

export function createSystemUsageApi({ auth, env = process.env, usage = createSystemUsage({ env }), fetchImpl = globalThis.fetch, now = Date.now }) {
    const router = express.Router();
    let panel = null;   // { at, state, diskBytes }; a failed request is remembered too, so it is not repeated at once
    let asking = null;

    async function askPanel() {
        try {
            const base = new URL(env.HOSTING_PANEL_URL).origin;
            const response = await fetchImpl(`${base}/api/client/servers/${encodeURIComponent(env.HOSTING_SERVER_ID)}/resources`, {
                headers: { Authorization: `Bearer ${env.HOSTING_API_KEY}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error('panel');
            const attributes = (await response.json())?.attributes;
            return { state: typeof attributes?.current_state === 'string' ? attributes.current_state.slice(0, 32) : null, diskBytes: amount(attributes?.resources?.disk_bytes) };
        } catch {
            return { state: null, diskBytes: null };
        }
    }

    /** What the panel last said. Never waits for the panel: the answer arrives with a later poll. */
    function panelFacts() {
        if (!hostingConfigured(env)) return null;
        if (!asking && (!panel || now() - panel.at >= PANEL_REFRESH_MS)) {
            asking = askPanel().then((facts) => { panel = { at: now(), ...facts }; }).finally(() => { asking = null; });
        }
        return panel;
    }

    router.get('/system-usage', auth, async (req, res) => {
        if (!botOwnerIds(env).includes(req.session.user.id)) return res.status(403).json({ error: 'Pemakaian sistem hanya untuk owner bot.' });
        try {
            const sample = await usage.sample();
            const facts = panelFacts();
            const disk = facts?.diskBytes != null
                ? { ...sample.disk, usedBytes: facts.diskBytes, measuredAt: facts.at, complete: true, source: 'panel' }
                : sample.disk;
            res.json({ ...sample, disk, panel: { configured: hostingConfigured(env), state: facts?.state ?? null } });
        } catch {
            res.status(503).json({ error: 'Pemakaian sistem tidak dapat dibaca.' });
        }
    });
    return router;
}
