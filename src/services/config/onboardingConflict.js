import {createError, ErrorTypes} from '../../utils/errorHandler.js';

// Caller must hold the guild row lock before reading either record and writing.
// All cooperating writers must use that same lock order (guild, then welcome).
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function reject(message, userMessage) {
    const error = createError(message, ErrorTypes.CONFIGURATION, userMessage);
    error.status = 409;
    throw error;
}
export function assertOnboardingShape(guild, welcome) {
    if (!object(guild) || !object(welcome) ||
        (guild.ok !== undefined && guild.value !== undefined) ||
        (welcome.ok !== undefined && welcome.value !== undefined)) {
        reject('Invalid onboarding configuration', 'Server or welcome settings need review before editing.');
    }
    if (guild.autoRole !== undefined && guild.autoRole !== null && typeof guild.autoRole !== 'string') {
        reject('Invalid autorole configuration', 'Server autorole settings need review before editing.');
    }
    const verification = guild.verification;
    if (verification !== undefined && (!object(verification) ||
        (verification.enabled !== undefined && typeof verification.enabled !== 'boolean') ||
        (verification.autoVerify !== undefined && (!object(verification.autoVerify) ||
            (verification.autoVerify.enabled !== undefined && typeof verification.autoVerify.enabled !== 'boolean'))))) {
        reject('Invalid verification configuration', 'Verification settings need review before editing.');
    }
    if (welcome.roleIds !== undefined && (!Array.isArray(welcome.roleIds) || welcome.roleIds.some(id => typeof id !== 'string' || !id))) {
        reject('Invalid welcome autorole configuration', 'Welcome autorole settings need review before editing.');
    }
}
export function assertOnboardingCompatible(guild, welcome) {
    assertOnboardingShape(guild, welcome);
    const verification = guild.verification;
    const verificationEnabled = verification?.enabled === true;
    const autoVerifyEnabled = verification?.autoVerify?.enabled === true;
    const autoroleEnabled = Boolean(guild.autoRole) || Boolean(welcome.roleIds?.length);
    if (((verificationEnabled || autoVerifyEnabled) && autoroleEnabled) || (verificationEnabled && autoVerifyEnabled)) {
        reject('Conflicting onboarding configuration', 'Disable conflicting autorole, verification or auto-verify settings before saving.');
    }
}
