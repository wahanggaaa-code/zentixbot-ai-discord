import { isDeepStrictEqual } from 'node:util';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildConfig, setGuildConfig } from './guildConfig.js';

// Preserve the verification state shown when the interaction began. Do not
// attach a stale nested object to a fresh guild snapshot without comparing it.
export async function saveVerificationDashboardChange(client, guildId, shared, expected, changes) {
    const current = await getGuildConfig(client, guildId);
    if (!isDeepStrictEqual(current.verification, expected)) {
        throw createError('Stale verification dashboard', ErrorTypes.CONFIGURATION,
            'Verification settings changed. Reload the dashboard before saving.');
    }
    current.verification = { ...structuredClone(expected), ...structuredClone(changes) };
    const saved = await setGuildConfig(client, guildId, current);
    // Do not change session state after a rejected write, or overwrite another
    // successful update that finished while this call was awaiting the DB.
    if (isDeepStrictEqual(shared, expected)) {
        for (const key of Object.keys(shared)) delete shared[key];
        Object.assign(shared, structuredClone(saved.verification));
    }
    return saved.verification;
}
