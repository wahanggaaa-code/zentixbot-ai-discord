import test from 'node:test';
import assert from 'node:assert/strict';
import { openSQLiteStore } from '../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../src/services/storage/sqliteBotDatabase.js';
import { updateGuildConfig, getGuildConfig } from '../src/services/config/guildConfig.js';
import { withEconomyTransaction } from '../src/services/economy/transaction.js';
import { purchasePremiumRole } from '../src/services/economy/premiumRole.js';
import { purchaseInventoryItem } from '../src/services/economy/shop.js';
import { getCurrency } from '../src/services/economy/currency.js';
import { getEconomyData } from '../src/utils/economy.js';
import { shopItems } from '../src/config/shop/items.js';
import leaderboardCommand from '../src/commands/Economy/eleaderboard.js';
import economyCommand from '../src/commands/Economy/economy.js';

// The same purchase rules on the SQLite backend (no PostgreSQL needed).

const guildId = '123456789012345678';
const botId = '900000000000000001';
const buyerId = '700000000000000001';
const friendId = '700000000000000002';
const roleId = '600000000000000001';
const premium = shopItems.find((item) => item.id === 'premium_role');
const item = (id) => shopItems.find((entry) => entry.id === id);
const said = (pattern) => (error) => {
    assert.match(error.userMessage ?? '', pattern);
    return true;
};

async function fixture(t, { wallet = 20_000 } = {}) {
    const sqlite = await openSQLiteStore();
    t.after(() => sqlite.close());
    const adapter = createSQLiteBotDatabase(sqlite);
    const hooks = { addRole: null, fetchMember: null };
    const given = [];
    const role = (id, extra = {}) => ({
        id, name: 'Premium', managed: false, position: 10, permissions: { has: () => false }, toString: () => `<@&${id}>`, ...extra,
    });
    const roles = new Map([[guildId, role(guildId, { name: '@everyone', position: 0 })], [roleId, role(roleId)]]);
    const members = new Map();
    const me = { id: botId, permissions: { has: () => true }, roles: { highest: { comparePositionTo: (other) => 50 - other.position } } };
    const guild = {
        id: guildId,
        name: 'Server',
        roles: { cache: roles, everyone: roles.get(guildId), fetch: async (id) => roles.get(id) ?? null },
        members: {
            me,
            cache: members,
            fetch: async (query) => {
                const id = typeof query === 'string' ? query : query.user;
                await hooks.fetchMember?.(id);
                return members.get(id);
            },
        },
    };
    const addMember = (id) => {
        const held = new Map();
        const member = {
            id,
            user: { id, username: `user-${id.slice(-2)}`, tag: `user-${id.slice(-2)}`, bot: false },
            roles: {
                cache: held,
                add: async (target, reason) => {
                    await hooks.addRole?.(target, reason);
                    held.set(target.id, target);
                    given.push({ userId: id, roleId: target.id });
                },
            },
        };
        members.set(id, member);
        return member;
    };
    const client = {
        homeGuildId: guildId,
        user: { id: botId },
        guilds: { cache: new Map([[guildId, guild]]) },
        db: {
            db: adapter,
            isAvailable: () => true,
            getStatus: () => ({ isDegraded: false }),
            list: (...args) => adapter.list(...args),
            get: (...args) => adapter.get(...args),
        },
    };
    await updateGuildConfig(client, guildId, { premiumRoleId: roleId });
    const buyer = addMember(buyerId);
    await withEconomyTransaction(client, guildId, [buyerId], (accounts) => { accounts.get(buyerId).wallet = wallet; });
    const account = () => sqlite.getAccount(guildId, buyerId);
    const buy = () => purchasePremiumRole({ client, guild, member: buyer, item: premium });
    return { sqlite, client, guild, hooks, given, buyer, addMember, account, buy, roles };
}

function interaction(fx, member, extra = {}) {
    const replies = [];
    const it = {
        id: '910000000000000001',
        user: { ...member.user, displayAvatarURL: () => 'https://example.invalid/a.png' },
        member,
        guild: fx.guild,
        guildId,
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        isChatInputCommand: () => true,
        memberPermissions: { has: () => true },
        options: { getSubcommand: () => 'dashboard', getString: () => null, getInteger: () => null, getUser: () => null },
        deferReply: async () => { it.deferred = true; },
        editReply: async (payload) => { replies.push(payload); },
        reply: async (payload) => { replies.push(payload); it.replied = true; },
        followUp: async (payload) => { replies.push(payload); },
        ...extra,
    };
    const text = () => replies.flatMap((payload) => payload.embeds ?? []).map((embed) => embed?.data ?? embed).map((embed) => [
        embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
    ].join('\n')).join('\n');
    return { it, text };
}

test('SQLite: premium role is paid, delivered and recorded; a refused role is refunded once', async (t) => {
    const fx = await fixture(t);
    const result = await fx.buy();
    assert.equal(result.status, 'purchased');
    assert.equal(fx.account().wallet, 20_000 - premium.price);
    assert.equal(fx.account().purchases.premium_role.status, 'delivered');
    assert.deepEqual(fx.given, [{ userId: buyerId, roleId }]);
    await assert.rejects(fx.buy(), said(/already have/));
    assert.equal(fx.account().wallet, 20_000 - premium.price);

    const refused = await fixture(t);
    refused.hooks.addRole = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    await assert.rejects(refused.buy(), said(/returned|refunded/i));
    assert.equal(refused.account().wallet, 20_000);
    assert.equal(refused.account().purchases?.premium_role, undefined);
    assert.deepEqual(refused.given, []);
});

test('SQLite: unknown outcome keeps the payment and the next purchase delivers without a second charge', async (t) => {
    const fx = await fixture(t);
    fx.hooks.addRole = async () => { throw new Error('socket hang up'); };
    fx.hooks.fetchMember = async () => { throw new Error('socket hang up'); };
    await assert.rejects(fx.buy(), said(/without paying twice/));
    assert.equal(fx.account().wallet, 20_000 - premium.price);
    assert.equal(fx.account().purchases.premium_role.status, 'pending');

    fx.hooks.addRole = null;
    fx.hooks.fetchMember = null;
    assert.equal((await fx.buy()).status, 'resumed');
    assert.equal(fx.account().wallet, 20_000 - premium.price);
    assert.equal(fx.account().purchases.premium_role.status, 'delivered');
});

test('SQLite: an unsafe or missing premium role charges nothing; three purchases at once charge once', async (t) => {
    const fx = await fixture(t, { wallet: 60_000 });
    fx.roles.get(roleId).permissions.has = () => true;
    await assert.rejects(fx.buy(), said(/Nothing was charged/));
    assert.equal(fx.account().wallet, 60_000);
    fx.roles.get(roleId).permissions.has = () => false;

    fx.hooks.addRole = () => new Promise((resolve) => setTimeout(resolve, 40));
    const results = await Promise.allSettled([fx.buy(), fx.buy(), fx.buy()]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(fx.account().wallet, 60_000 - premium.price);
    assert.equal(fx.given.length, 1);
});

test('SQLite: shop limits hold, also for purchases made at once', async (t) => {
    const fx = await fixture(t, { wallet: 200_000 });
    const purchase = (id, quantity = 1) => purchaseInventoryItem({
        client: fx.client, guildId, userId: buyerId, item: item(id), quantity,
    });
    await purchase('bank_upgrade_1');
    await assert.rejects(purchase('bank_upgrade_1'), said(/already own/));
    await assert.rejects(purchase('pickaxe', 2), said(/only need one/));

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => purchase('extra_work')));
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 5);
    const data = await getEconomyData(fx.client, guildId, buyerId);
    assert.equal(data.inventory.extra_work, 5);
    assert.equal(data.wallet, 200_000 - 15_000 - 5 * 5_000);
});

test('SQLite: /eleaderboard and /economy dashboard read the accounts; the currency is kept in the settings', async (t) => {
    const fx = await fixture(t, { wallet: 500 });
    const friend = fx.addMember(friendId);
    await withEconomyTransaction(fx.client, guildId, [friendId], (accounts) => {
        accounts.get(friendId).wallet = 1_000;
        accounts.get(friendId).bank = 2_500;
    });

    const board = interaction(fx, fx.buyer);
    await leaderboardCommand.execute(board.it, {}, fx.client);
    assert.match(board.text(), new RegExp(`<@${friendId}>[^\\n]*3,500[\\s\\S]*<@${buyerId}>[^\\n]*500`));
    assert.match(board.text(), /Your rank: \*\*#2\*\* of 2/);

    const handlers = {};
    const root = interaction(fx, friend, {
        channel: { createMessageComponentCollector: () => ({ on: (event, handler) => { handlers[event] = handler; } }) },
    });
    await economyCommand.execute(root.it, {}, fx.client);
    assert.match(root.text(), /Total in Circulation: `\$4,000`/);
    assert.match(root.text(), /Active Users: `2`/);

    const submitted = interaction(fx, friend, {
        fields: { getTextInputValue: () => 'Rp', getField: () => ({ values: [] }) },
    });
    const select = interaction(fx, friend, {
        values: ['change_currency'],
        showModal: async () => {},
        deferUpdate: async () => {},
        awaitModalSubmit: async () => submitted.it,
    });
    await handlers.collect(select.it);
    assert.match(submitted.text(), /Currency symbol changed to \*\*Rp\*\*/);
    const config = await getGuildConfig(fx.client, guildId);
    assert.deepEqual(getCurrency(config), { symbol: 'Rp', name: 'coins' });
    assert.equal(config.premiumRoleId, roleId);
});
