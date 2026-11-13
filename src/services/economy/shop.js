// shop.js — rules for buying inventory items, applied inside the account
// transaction so that the check and the payment cannot be separated.

import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { withEconomyTransaction } from './transaction.js';

const INVENTORY_TYPES = ['upgrade', 'consumable', 'tool'];
// Every bank note raises the bank capacity, so more than one is useful.
const STACKABLE_TOOLS = new Set(['bank_note']);

const money = (amount) => `$${amount.toLocaleString()}`;

function refuse(message, context) {
    return createError('Purchase refused', ErrorTypes.VALIDATION, message, context);
}

/**
 * Why this purchase would be money spent for nothing, or null when it is fine.
 * `account` is the account as read inside the transaction.
 */
export function purchaseLimit(item, quantity, account) {
    const owned = Number(account.inventory?.[item.id]) || 0;

    if (item.type === 'upgrade') {
        if (account.upgrades?.[item.id]) return `You already own **${item.name}**.`;
        if (quantity > 1) return `**${item.name}** can only be bought once.`;
    }
    if (item.type === 'tool' && !STACKABLE_TOOLS.has(item.id)) {
        if (owned > 0) return `You already have a **${item.name}**.`;
        if (quantity > 1) return `You only need one **${item.name}**.`;
    }
    if (item.type === 'consumable' && Number.isInteger(item.maxQuantity)) {
        if (owned + quantity > item.maxQuantity) {
            return `You can hold at most **${item.maxQuantity}** of **${item.name}** and already have **${owned}**.`;
        }
    }
    return null;
}

/**
 * Buy an upgrade, tool or consumable: one transaction checks the limits and
 * the wallet, takes the money and adds the item.
 * Returns `{ wallet, totalCost }`.
 */
export async function purchaseInventoryItem({ client, guildId, userId, item, quantity }) {
    if (!item || !INVENTORY_TYPES.includes(item.type)) {
        throw refuse('This item is not available.', { itemId: item?.id });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        throw refuse('You must purchase a quantity between 1 and 10.', { quantity });
    }
    const totalCost = item.price * quantity;
    if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
        throw refuse('This item is not available.', { itemId: item.id });
    }

    return withEconomyTransaction(client, guildId, [userId], (accounts) => {
        const account = accounts.get(userId);
        const limit = purchaseLimit(item, quantity, account);
        if (limit) throw refuse(limit, { itemId: item.id, quantity });
        if (account.wallet < totalCost) {
            throw refuse(
                `You need **${money(totalCost)}** to purchase ${quantity}x **${item.name}**, `
                + `but you only have **${money(account.wallet)}** in cash.`,
                { required: totalCost, current: account.wallet, itemId: item.id, quantity },
            );
        }
        account.wallet -= totalCost;
        if (item.type === 'upgrade') {
            account.upgrades = account.upgrades ?? {};
            account.upgrades[item.id] = true;
        } else {
            account.inventory = account.inventory ?? {};
            account.inventory[item.id] = (Number(account.inventory[item.id]) || 0) + quantity;
        }
        return { wallet: account.wallet, totalCost };
    });
}
