// premiumRole.js — selling the premium role.
//
// Discord and the database are not one transaction, so the purchase is a
// small protocol that can stop at any point without losing money or giving
// the role for free:
//
//   1. one account transaction takes the price and records the purchase as
//      "pending" in the account;
//   2. the role is given;
//   3. the record becomes "delivered".
//
// When the role cannot be given, the price is returned in a transaction of
// its own, and only while the pending record is still there. When it is not
// known whether Discord gave the role, nothing is returned: the pending
// record stays, and the next /buy settles it (role present: delivered; role
// absent: the role is tried again without a second payment).

import { getGuildConfig } from '../config/guildConfig.js';
import { checkRewardRole } from '../leveling/rewardRoles.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { withEconomyTransaction } from './transaction.js';

export const PREMIUM_ITEM_ID = 'premium_role';

const REASONS = {
    ROLE_MISSING: 'The role no longer exists.',
    ROLE_EVERYONE: 'The @everyone role cannot be sold.',
    ROLE_MANAGED: 'The role is managed by an integration and cannot be assigned.',
    ROLE_DANGEROUS: 'The role grants server management or moderation permissions.',
    BOT_MEMBER_UNKNOWN: 'The bot member is not available for this server.',
    BOT_NO_MANAGE_ROLES: 'The bot lacks the Manage Roles permission.',
    ROLE_TOO_HIGH: 'The role is not below the bot\'s highest role.',
};

const money = (amount) => `$${amount.toLocaleString()}`;

// How long a completed purchase blocks a new one for the same member.
const RECENT_DELIVERY_MS = 60_000;

/**
 * May `role` be sold as the premium role in `guild` right now?
 * Same rules as level reward roles. Returns `{ok:true}` or
 * `{ok:false, code, message}`. Never throws.
 */
export function checkPremiumRole(guild, role) {
    const verdict = checkRewardRole(guild, role);
    if (verdict.ok) return verdict;
    return { ...verdict, message: REASONS[verdict.code] ?? 'The role cannot be assigned.' };
}

function pendingOf(account) {
    const record = account.purchases?.[PREMIUM_ITEM_ID];
    const valid = record && record.status === 'pending'
        && Number.isSafeInteger(record.price) && record.price >= 0;
    return valid ? record : null;
}

function setRecord(account, record) {
    account.purchases = { ...(account.purchases ?? {}), [PREMIUM_ITEM_ID]: record };
}

function clearRecord(account) {
    const { [PREMIUM_ITEM_ID]: removed, ...rest } = account.purchases ?? {};
    account.purchases = rest;
}

async function lookUpRole(guild, roleId) {
    if (!roleId) return null;
    const cached = guild.roles?.cache?.get?.(roleId);
    if (cached) return cached;
    return guild.roles.fetch(roleId).catch(() => null);
}

/** true / false when Discord answers, null when it does not. */
async function memberHasRole(guild, userId, roleId) {
    try {
        const fresh = await guild.members.fetch({ user: userId, force: true });
        return fresh?.roles?.cache?.has?.(roleId) === true;
    } catch {
        return null;
    }
}

/**
 * Buy the premium role for `member`.
 *
 * Resolves with `{ status, wallet, role }` where status is
 *   'purchased'  the price was taken now and the role was given;
 *   'resumed'    an earlier payment was still pending and the role was given
 *                now without a second payment.
 * Every other outcome throws an error with a text for the member. The text
 * always says what happened to the money.
 */
export async function purchasePremiumRole({ client, guild, member, item, now = Date.now() }) {
    const price = item?.price;
    if (!guild?.id || !member?.id || !Number.isSafeInteger(price) || price < 0) {
        throw createError('Invalid premium purchase', ErrorTypes.VALIDATION, 'This item is not available.');
    }
    const guildId = guild.id;
    const userId = member.id;
    const context = { guildId, userId, itemId: PREMIUM_ITEM_ID };

    // One purchase per member at a time inside this process.
    return Mutex.runExclusive(`economy:premium:${guildId}:${userId}`, async () => {
        const config = await getGuildConfig(client, guildId);
        const roleId = config?.premiumRoleId || null;
        const role = await lookUpRole(guild, roleId);
        const verdict = roleId ? checkPremiumRole(guild, role) : { ok: false, code: 'NOT_CONFIGURED' };
        const hasRole = Boolean(roleId && member.roles?.cache?.has?.(roleId));

        const step = await withEconomyTransaction(client, guildId, [userId], (accounts) => {
            const account = accounts.get(userId);
            const pending = pendingOf(account);

            if (!verdict.ok) {
                if (!pending) return { action: 'unavailable' };
                // Paid earlier, and the role can no longer be delivered.
                account.wallet += pending.price;
                clearRecord(account);
                return { action: 'refunded', price: pending.price, wallet: account.wallet };
            }
            if (hasRole) {
                if (pending) setRecord(account, { ...pending, status: 'delivered', deliveredAt: now });
                return { action: 'owned' };
            }
            if (pending) return { action: 'resume', at: pending.at, price: pending.price, wallet: account.wallet };

            // A purchase that was completed a moment ago, possibly by another
            // request whose role this request has not seen yet: do not charge again.
            const last = account.purchases?.[PREMIUM_ITEM_ID];
            const sinceDelivery = last?.status === 'delivered' ? now - Number(last.deliveredAt) : NaN;
            if (sinceDelivery >= 0 && sinceDelivery < RECENT_DELIVERY_MS) return { action: 'owned' };

            if (account.wallet < price) {
                throw createError(
                    'Insufficient funds',
                    ErrorTypes.VALIDATION,
                    `You need **${money(price)}** to purchase **${item.name}**, `
                    + `but you only have **${money(account.wallet)}** in cash.`,
                    { ...context, required: price, current: account.wallet },
                );
            }
            account.wallet -= price;
            setRecord(account, { status: 'pending', roleId, price, at: now });
            return { action: 'charged', at: now, price, wallet: account.wallet };
        });

        if (step.action === 'unavailable') {
            const text = verdict.code === 'NOT_CONFIGURED'
                ? 'The **Premium Shop Role** has not been configured by a server administrator yet.'
                : `The premium role cannot be sold right now. ${verdict.message} Nothing was charged.`;
            throw createError('Premium role unavailable', ErrorTypes.CONFIGURATION, text, { ...context, code: verdict.code });
        }
        if (step.action === 'refunded') {
            logger.info('[ECONOMY_TRANSACTION] Premium role payment returned', { ...context, amount: step.price, reason: verdict.code });
            throw createError(
                'Premium role unavailable, earlier payment returned',
                ErrorTypes.CONFIGURATION,
                `The premium role cannot be sold right now. Your earlier payment of **${money(step.price)}** `
                + `was returned. Cash: **${money(step.wallet)}**.`,
                { ...context, code: verdict.code },
            );
        }
        if (step.action === 'owned') {
            throw createError('Role already owned', ErrorTypes.VALIDATION, `You already have the **${item.name}** role.`, context);
        }

        // step.action is 'charged' or 'resume': the price is paid, the role is due.
        const ours = (account) => {
            const pending = pendingOf(account);
            return pending && pending.at === step.at ? pending : null;
        };

        let given = true;
        let addError = null;
        try {
            await member.roles.add(role, `Purchased role: ${item.name}`);
        } catch (error) {
            addError = error;
            given = await memberHasRole(guild, userId, roleId);
        }

        if (given === true) {
            try {
                await withEconomyTransaction(client, guildId, [userId], (accounts) => {
                    const account = accounts.get(userId);
                    const pending = ours(account);
                    if (pending) setRecord(account, { ...pending, status: 'delivered', deliveredAt: now });
                });
            } catch (error) {
                // Paid and delivered; the next /buy sees the role and closes the record.
                logger.warn('[ECONOMY] Premium role delivered but the record stayed pending', { ...context, error: error.message });
            }
            logger.info('[ECONOMY_TRANSACTION] Premium role purchased', {
                ...context, roleId, amount: step.price, resumed: step.action === 'resume', newWallet: step.wallet,
            });
            return { status: step.action === 'resume' ? 'resumed' : 'purchased', wallet: step.wallet, role, price: step.price };
        }

        if (given === null) {
            logger.error('[ECONOMY] Premium role outcome unknown; payment kept as pending', { ...context, roleId, error: addError?.message });
            throw createError(
                'Premium role outcome unknown',
                ErrorTypes.DISCORD_API,
                `Discord did not confirm whether the role was given. Your payment of **${money(step.price)}** is on record: `
                + 'run `/buy` again in a moment and you will get the role without paying twice.',
                { ...context, originalError: addError?.message },
            );
        }

        // The role was not given: return the price, once.
        let refund;
        try {
            refund = await withEconomyTransaction(client, guildId, [userId], (accounts) => {
                const account = accounts.get(userId);
                const pending = ours(account);
                if (!pending) return { returned: false, wallet: account.wallet };
                account.wallet += pending.price;
                clearRecord(account);
                return { returned: true, wallet: account.wallet };
            });
        } catch (error) {
            logger.error('[ECONOMY] Premium role refund failed; payment kept as pending', { ...context, roleId, error: error.message });
            throw createError(
                'Premium role refund failed',
                ErrorTypes.DATABASE,
                `The role could not be given and the refund could not be completed. Your payment of **${money(step.price)}** `
                + 'is on record: run `/buy` again later and you will get the role or your money back without paying twice.',
                { ...context, originalError: addError?.message },
            );
        }
        logger.warn('[ECONOMY_TRANSACTION] Premium role not given; payment returned', {
            ...context, roleId, amount: step.price, returned: refund.returned, error: addError?.message,
        });
        const moneyText = refund.returned
            ? `The role could not be given, so your **${money(step.price)}** was returned.`
            : 'The role could not be given. The payment record was already closed, so nothing was returned by this attempt.';
        throw createError(
            'Role assignment failed',
            ErrorTypes.DISCORD_API,
            `${moneyText} Cash: **${money(refund.wallet)}**. `
            + 'Ask a server administrator to check the bot\'s role permissions.',
            { ...context, roleId, originalError: addError?.message },
        );
    });
}
