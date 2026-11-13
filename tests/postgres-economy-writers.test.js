import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    createLevelingFixture, pgEnabled, guildId, member, role, missingPermissions, unknownMember,
} from './helpers/leveling-postgres-fixture.js';
import { shopItems } from '../src/config/shop/items.js';
import { purchasePremiumRole, checkPremiumRole } from '../src/services/economy/premiumRole.js';
import { purchaseInventoryItem } from '../src/services/economy/shop.js';
import { getEconomyData, setEconomyData } from '../src/utils/economy.js';
import EconomyService from '../src/services/economyService.js';
import buyCommand from '../src/commands/Economy/buy.js';
import payCommand from '../src/commands/Economy/pay.js';
import leaderboardCommand from '../src/commands/Economy/eleaderboard.js';
import setRoleCommand from '../src/commands/Economy/modules/shop_config_setrole.js';
import { createModulesApi } from '../src/dashboard/modulesApi.js';
import economyCommand from '../src/commands/Economy/economy.js';
import { getCurrency, parseAdminAmount } from '../src/services/economy/currency.js';

const skip = !pgEnabled;
const premium = shopItems.find((item) => item.id === 'premium_role');
const PRICE = premium.price;
const item = (id) => shopItems.find((entry) => entry.id === id);

// Queries by purpose. The transaction writes "SET balance=$3"; the read-only
// helpers select "balance, bank, data" with spaces.
const WRITE_ACCOUNT = /UPDATE economy SET balance=/;
const PLAIN_READ = /SELECT (user_id, )?balance, bank, data FROM economy/;

/** Fixture with a usable premium role (unless `premiumRoleId` says otherwise). */
async function shop(t, { premiumRoleId = role(1), wallet = 20_000 } = {}) {
    const fx = await createLevelingFixture(t);
    fx.addRole(role(1), { name: 'Premium' });
    const config = (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config;
    await fx.query('UPDATE guilds SET config = $2::jsonb WHERE id = $1', [guildId, JSON.stringify({ ...config, premiumRoleId })]);
    const buyer = fx.addMember(member(1));
    if (wallet !== null) await setAccount(fx, buyer.id, { wallet });
    return { fx, buyer };
}

async function setAccount(fx, userId, data) {
    const full = { wallet: 0, bank: 0, inventory: {}, upgrades: {}, ...data };
    await fx.query('INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
    await fx.query(
        `INSERT INTO economy(guild_id, user_id, balance, bank, data) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = EXCLUDED.balance, bank = EXCLUDED.bank, data = EXCLUDED.data`,
        [guildId, userId, full.wallet, full.bank, JSON.stringify(full)],
    );
}

async function account(fx, userId) {
    const result = await fx.query('SELECT balance, bank, data FROM economy WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    const row = result.rows[0];
    if (!row) return null;
    // The columns and the JSON must tell the same story.
    assert.equal(Number(row.balance), row.data.wallet);
    assert.equal(Number(row.bank), row.data.bank);
    return row.data;
}

const record = async (fx, userId) => (await account(fx, userId)).purchases?.premium_role ?? null;
const buy = (fx, buyer) => purchasePremiumRole({ client: fx.client, guild: fx.guild, member: buyer, item: premium });
const said = (pattern) => (error) => {
    assert.match(error.userMessage ?? '', pattern);
    return true;
};

function interaction(fx, user, options = {}) {
    const replies = [];
    const it = {
        id: '910000000000000001',
        user: { ...user.user, displayAvatarURL: () => 'https://example.invalid/a.png' },
        member: user,
        guild: fx.guild,
        guildId,
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        isChatInputCommand: () => true,
        options: {
            getString: (name) => options[name] ?? null,
            getInteger: (name) => options[name] ?? null,
            getUser: (name) => options[name] ?? null,
            getRole: (name) => options[name] ?? null,
        },
        deferReply: async () => { it.deferred = true; },
        editReply: async (payload) => { replies.push(payload); },
        reply: async (payload) => { replies.push(payload); it.replied = true; },
        followUp: async (payload) => { replies.push(payload); },
    };
    const embeds = () => replies.flatMap((payload) => payload.embeds ?? []).map((embed) => embed?.data ?? embed);
    const text = () => embeds().map((embed) => [
        embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`), embed.footer?.text,
    ].join('\n')).join('\n');
    return { it, text };
}

// ---- premium role: the purchase protocol --------------------------------------

test('premium role: the price is taken first, then the role is given and the record closed', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    const seen = [];
    fx.hooks.addRole = async () => {
        const data = await account(fx, buyer.id);
        seen.push({ wallet: data.wallet, status: data.purchases.premium_role.status });
    };

    const result = await buy(fx, buyer);
    assert.equal(result.status, 'purchased');
    assert.equal(result.wallet, 20_000 - PRICE);
    assert.deepEqual(seen, [{ wallet: 20_000 - PRICE, status: 'pending' }], 'paid and recorded before Discord was asked');
    assert.deepEqual(fx.rolesOf(buyer.id), [role(1)]);
    assert.match(fx.given[0].reason, /Purchased role/);

    const stored = await account(fx, buyer.id);
    assert.equal(stored.wallet, 20_000 - PRICE);
    assert.equal(stored.purchases.premium_role.status, 'delivered');
    assert.equal(stored.purchases.premium_role.roleId, role(1));
    assert.equal(stored.purchases.premium_role.price, PRICE);
});

test('premium role: too little cash charges nothing and gives nothing', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: PRICE - 1 });
    await assert.rejects(buy(fx, buyer), said(/You need \*\*\$15,000\*\*.*only have \*\*\$14,999\*\*/));
    assert.equal((await account(fx, buyer.id)).wallet, PRICE - 1);
    assert.equal(await record(fx, buyer.id), null);
    assert.deepEqual(fx.rolesOf(buyer.id), []);
});

test('premium role: when Discord refuses the role, the price is returned once', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    fx.hooks.addRole = async () => { throw missingPermissions(); };

    await assert.rejects(buy(fx, buyer), said(/could not be given, so your \*\*\$15,000\*\* was returned\. Cash: \*\*\$20,000\*\*/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);
    assert.equal(await record(fx, buyer.id), null);
    assert.deepEqual(fx.rolesOf(buyer.id), []);

    // Trying again starts a normal purchase; nothing is left over from the failure.
    fx.hooks.addRole = null;
    assert.equal((await buy(fx, buyer)).status, 'purchased');
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE);
});

test('premium role: a payment already settled by another process is not returned a second time', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    // While this purchase is failing, another bot process returns the payment.
    fx.hooks.addRole = async () => {
        const data = await account(fx, buyer.id);
        const { premium_role: settled, ...purchases } = data.purchases;
        assert.equal(settled.status, 'pending');
        await setAccount(fx, buyer.id, { ...data, wallet: data.wallet + PRICE, purchases });
        throw missingPermissions();
    };

    await assert.rejects(buy(fx, buyer), said(/could not be given/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000, 'returned once, not twice');
    assert.equal(await record(fx, buyer.id), null);
});

test('premium role: an error after Discord applied the role is not refunded', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    fx.hooks.addRole = async (target, given) => {
        target.roles.cache.set(given.id, given);
        throw new Error('socket hang up');
    };

    const result = await buy(fx, buyer);
    assert.equal(result.status, 'purchased');
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE);
    assert.equal((await record(fx, buyer.id)).status, 'delivered');
});

test('premium role: unknown outcome keeps the payment on record; the next /buy delivers without charging again', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    fx.hooks.addRole = async () => { throw new Error('socket hang up'); };
    fx.hooks.fetchMember = async () => { throw new Error('socket hang up'); };

    await assert.rejects(buy(fx, buyer), said(/did not confirm.*payment of \*\*\$15,000\*\* is on record.*without paying twice/s));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE, 'no refund while the outcome is unknown');
    assert.equal((await record(fx, buyer.id)).status, 'pending');

    fx.hooks.addRole = null;
    fx.hooks.fetchMember = null;
    const result = await buy(fx, buyer);
    assert.equal(result.status, 'resumed');
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE, 'not charged a second time');
    assert.equal((await record(fx, buyer.id)).status, 'delivered');
    assert.deepEqual(fx.rolesOf(buyer.id), [role(1)]);
});

test('premium role: a refund that cannot be stored leaves the payment on record', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    fx.hooks.addRole = async () => {
        // From here on the database refuses account writes: the refund fails.
        fx.control.failQuery = (sql) => WRITE_ACCOUNT.test(sql);
        throw missingPermissions();
    };

    await assert.rejects(buy(fx, buyer), said(/refund could not be completed.*on record.*without paying twice/s));
    fx.control.failQuery = null;
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE);
    assert.equal((await record(fx, buyer.id)).status, 'pending');

    // Discord still refuses: this time the refund goes through.
    fx.hooks.addRole = async () => { throw missingPermissions(); };
    await assert.rejects(buy(fx, buyer), said(/was returned\. Cash: \*\*\$20,000\*\*/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);
    assert.equal(await record(fx, buyer.id), null);
});

test('premium role: a member who already has the role is not charged; an open record is closed', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    buyer.roles.cache.set(role(1), fx.roles.get(role(1)));

    await assert.rejects(buy(fx, buyer), said(/already have/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);

    // Paid earlier, role arrived, record never closed (process stopped in between).
    await setAccount(fx, buyer.id, { wallet: 5_000, purchases: { premium_role: { status: 'pending', roleId: role(1), price: PRICE, at: 1 } } });
    await assert.rejects(buy(fx, buyer), said(/already have/));
    assert.equal((await account(fx, buyer.id)).wallet, 5_000);
    assert.equal((await record(fx, buyer.id)).status, 'delivered');

    // Delivered a moment ago by another request; this one has not seen the role yet.
    buyer.roles.cache.delete(role(1));
    const at = 1_700_000_000_000;
    await setAccount(fx, buyer.id, {
        wallet: 20_000,
        purchases: { premium_role: { status: 'delivered', roleId: role(1), price: PRICE, at, deliveredAt: at } },
    });
    const buyAt = (now) => purchasePremiumRole({ client: fx.client, guild: fx.guild, member: buyer, item: premium, now });
    await assert.rejects(buyAt(at + 10_000), said(/already have/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);
    assert.equal(fx.given.length, 0);

    // Later (the role was removed by staff, say) the member may buy it again.
    assert.equal((await buyAt(at + 120_000)).status, 'purchased');
    assert.equal((await account(fx, buyer.id)).wallet, 20_000 - PRICE);
});

test('premium role: not configured or not safe to sell charges nothing; an open payment is returned', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { premiumRoleId: null });
    await assert.rejects(buy(fx, buyer), said(/has not been configured/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);

    const cases = [
        [role(2), { permissions: ['Administrator'] }, /server management or moderation permissions\. Nothing was charged/],
        [role(3), { position: 80 }, /not below the bot's highest role\. Nothing was charged/],
        [role(4), { managed: true }, /managed by an integration.*Nothing was charged/],
        [role(5), null, /no longer exists\. Nothing was charged/],
    ];
    for (const [id, options, expected] of cases) {
        if (options) fx.addRole(id, options);
        const config = (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config;
        await fx.query('UPDATE guilds SET config = $2::jsonb WHERE id = $1', [guildId, JSON.stringify({ ...config, premiumRoleId: id })]);
        await assert.rejects(buy(fx, buyer), said(expected));
        assert.equal((await account(fx, buyer.id)).wallet, 20_000);
        assert.deepEqual(fx.rolesOf(buyer.id), []);
    }

    // The role became unsafe after a payment was taken: the money goes back.
    await setAccount(fx, buyer.id, { wallet: 5_000, purchases: { premium_role: { status: 'pending', roleId: role(1), price: PRICE, at: 1 } } });
    await assert.rejects(buy(fx, buyer), said(/earlier payment of \*\*\$15,000\*\* was returned\. Cash: \*\*\$20,000\*\*/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);
    assert.equal(await record(fx, buyer.id), null);
});

test('premium role: money moved by /pay during the purchase is neither lost nor created', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    const friend = fx.addMember(member(2));
    await setAccount(fx, friend.id, { wallet: 0 });

    // While Discord is giving the role, the buyer pays the rest to a friend.
    fx.hooks.addRole = async () => {
        await EconomyService.transferMoney(fx.client, guildId, buyer.id, friend.id, 5_000);
    };
    const purchase = interaction(fx, buyer, { item_id: 'premium_role' });
    await buyCommand.execute(purchase.it, {}, fx.client);
    assert.deepEqual(fx.rolesOf(buyer.id), [role(1)]);

    const after = { buyer: (await account(fx, buyer.id)).wallet, friend: (await account(fx, friend.id)).wallet };
    assert.deepEqual(after, { buyer: 0, friend: 5_000 });
    assert.equal(after.buyer + after.friend, 20_000 - PRICE, 'exactly the price left the two wallets');
});

test('premium role: two purchases at once charge once', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: 40_000 });
    // Discord is slow: the other two requests arrive while the first role is being given.
    fx.hooks.addRole = () => new Promise((resolve) => setTimeout(resolve, 60));
    const results = await Promise.allSettled([buy(fx, buyer), buy(fx, buyer), buy(fx, buyer)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await account(fx, buyer.id)).wallet, 40_000 - PRICE);
    assert.equal(fx.given.length, 1);
});

test('/buy premium_role: success and refusal texts; a quantity above 1 is refused before any charge', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);

    const many = interaction(fx, buyer, { item_id: 'premium_role', quantity: 2 });
    await assert.rejects(buyCommand.execute(many.it, {}, fx.client), said(/only purchase .* once/));
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);

    const ok = interaction(fx, buyer, { item_id: 'PREMIUM_ROLE' });
    await buyCommand.execute(ok.it, {}, fx.client);
    assert.match(ok.text(), /successfully purchased 1x \*\*Premium Server Role\*\* for \*\*\$15,000\*\*/);
    assert.match(ok.text(), new RegExp(`<@&${role(1)}> has been granted`));
    assert.match(ok.text(), /New Balance: \$5,000/);

    const again = interaction(fx, buyer, { item_id: 'premium_role' });
    await assert.rejects(buyCommand.execute(again.it, {}, fx.client), said(/already have/));
    assert.equal((await account(fx, buyer.id)).wallet, 5_000);
});

// ---- shop items -----------------------------------------------------------------

test('shop: a purchase that would buy nothing is refused without a charge', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: 1_000_000 });
    const purchase = (id, quantity = 1) => purchaseInventoryItem({ client: fx.client, guildId, userId: buyer.id, item: item(id), quantity });
    let expected = 1_000_000;
    const wallet = async () => (await account(fx, buyer.id)).wallet;

    // Upgrade: once.
    await assert.rejects(purchase('bank_upgrade_1', 2), said(/only be bought once/));
    await purchase('bank_upgrade_1'); expected -= item('bank_upgrade_1').price;
    await assert.rejects(purchase('bank_upgrade_1'), said(/already own/));
    assert.equal(await wallet(), expected);

    // Tool: one is enough.
    await assert.rejects(purchase('fishing_rod', 3), said(/only need one/));
    await purchase('fishing_rod'); expected -= item('fishing_rod').price;
    await assert.rejects(purchase('fishing_rod'), said(/already have a/));
    assert.equal(await wallet(), expected);

    // Bank notes stack: each one adds bank capacity.
    await purchase('bank_note', 2); expected -= 2 * item('bank_note').price;
    await purchase('bank_note', 1); expected -= item('bank_note').price;
    assert.equal(await wallet(), expected);

    // Consumable: up to its maximum.
    await purchase('extra_work', 4); expected -= 4 * item('extra_work').price;
    await assert.rejects(purchase('extra_work', 2), said(/at most \*\*5\*\*.*already have \*\*4\*\*/));
    await purchase('extra_work', 1); expected -= item('extra_work').price;
    assert.equal(await wallet(), expected);

    const stored = await account(fx, buyer.id);
    assert.deepEqual(stored.inventory, { fishing_rod: 1, bank_note: 3, extra_work: 5 });
    assert.deepEqual(stored.upgrades, { bank_upgrade_1: true });

    // Through the command: the same refusal, and the item ID is case-insensitive.
    const refused = interaction(fx, buyer, { item_id: 'Fishing_Rod' });
    await assert.rejects(buyCommand.execute(refused.it, {}, fx.client), said(/already have a/));
    assert.equal(await wallet(), expected);
});

test('shop: simultaneous purchases cannot pass the limit or overdraw the wallet', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: item('fishing_rod').price * 3 });
    const purchase = () => purchaseInventoryItem({ client: fx.client, guildId, userId: buyer.id, item: item('fishing_rod'), quantity: 1 });
    const results = await Promise.allSettled([purchase(), purchase(), purchase()]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const stored = await account(fx, buyer.id);
    assert.equal(stored.inventory.fishing_rod, 1);
    assert.equal(stored.wallet, item('fishing_rod').price * 2);
});

// ---- choosing the premium role ----------------------------------------------------

test('/shop-config setrole refuses a role that must not be sold and keeps the stored one', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    const admin = { ...buyer, permissions: { has: () => true } };
    fx.addRole(role(2), { name: 'Admin', permissions: ['Administrator'] });
    fx.addRole(role(3), { name: 'Above', position: 80 });
    fx.addRole(role(4), { name: 'VIP' });
    const stored = async () => (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config.premiumRoleId;

    for (const [id, expected] of [[role(2), /server management or moderation/], [role(3), /not below the bot/], [guildId, /@everyone/]]) {
        const refused = interaction(fx, admin, { role: fx.roles.get(id) });
        await setRoleCommand.execute(refused.it, {}, fx.client);
        assert.match(refused.text(), expected);
        assert.equal(await stored(), role(1));
    }

    const ok = interaction(fx, admin, { role: fx.roles.get(role(4)) });
    await setRoleCommand.execute(ok.it, {}, fx.client);
    assert.match(ok.text(), /Premium Role Set/);
    assert.equal(await stored(), role(4));

    assert.equal(checkPremiumRole(fx.guild, fx.roles.get(role(4))).ok, true);
    assert.equal(checkPremiumRole(fx.guild, fx.roles.get(role(2))).code, 'ROLE_DANGEROUS');
});

// ---- reading accounts ---------------------------------------------------------------

test('a failed account read is an error, not an empty account; whole-record writes are refused', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    assert.equal((await getEconomyData(fx.client, guildId, buyer.id)).wallet, 20_000);
    assert.equal((await getEconomyData(fx.client, guildId, member(9))).wallet, 0, 'a member without an account');

    fx.control.failQuery = (sql) => PLAIN_READ.test(sql);
    await assert.rejects(getEconomyData(fx.client, guildId, buyer.id), /injected database failure/);
    fx.control.failQuery = null;

    // The database is marked unusable: no balance is made up.
    const degraded = Object.create(fx.client.db);
    degraded.getStatus = () => ({ isDegraded: true });
    await assert.rejects(getEconomyData({ ...fx.client, db: degraded }, guildId, buyer.id), { code: 'ECONOMY_UNAVAILABLE' });

    await assert.rejects(setEconomyData(fx.client, guildId, buyer.id, { wallet: 1 }), { code: 'ECONOMY_LEGACY_WRITE_DISABLED' });
    assert.equal((await account(fx, buyer.id)).wallet, 20_000);
});

test('/pay reports the balances the transfer committed', { skip }, async (t) => {
    const { fx, buyer } = await shop(t);
    const friend = fx.addMember(member(2));
    await setAccount(fx, friend.id, { wallet: 100 });
    const dms = [];
    const receiver = {
        ...friend.user, bot: false, displayAvatarURL: () => 'https://example.invalid/b.png',
        send: async (payload) => dms.push(payload),
    };

    // Reads outside the transfer fail: the reply must not depend on them.
    fx.control.failQuery = (sql) => PLAIN_READ.test(sql);
    const pay = interaction(fx, buyer, { user: receiver, amount: 7_500 });
    await payCommand.execute(pay.it, {}, fx.client);
    fx.control.failQuery = null;

    assert.match(pay.text(), /Your New Balance: \$12,500/);
    const dm = dms[0].embeds[0].data ?? dms[0].embeds[0];
    assert.equal(dm.fields[0].value, '$7,600');
    assert.equal((await account(fx, buyer.id)).wallet, 12_500);
    assert.equal((await account(fx, friend.id)).wallet, 7_600);

    const tooMuch = interaction(fx, buyer, { user: receiver, amount: 12_501 });
    await assert.rejects(payCommand.execute(tooMuch.it, {}, fx.client), said(/only have \*\*\$12,500\*\*/));
    assert.equal((await account(fx, friend.id)).wallet, 7_600);
});

test('/eleaderboard ranks by wallet plus bank and reports a failed query as an error', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: null });
    await setAccount(fx, member(1), { wallet: 100, bank: 50 });
    await setAccount(fx, member(2), { wallet: 0, bank: 900 });
    await setAccount(fx, member(3), { wallet: 400, bank: 0 });

    const board = interaction(fx, buyer);
    await leaderboardCommand.execute(board.it, {}, fx.client);
    const lines = board.text().split('\n').filter((line) => line.includes('<@'));
    assert.deepEqual(lines.map((line) => line.match(/<@(\d+)> - \D*([\d,]+)$/).slice(1)), [
        [member(2), '900'], [member(3), '400'], [member(1), '150'],
    ]);
    assert.match(board.text(), /Your rank: \*\*#3\*\* of 3/);

    const outsider = interaction(fx, fx.addMember(member(8)));
    await leaderboardCommand.execute(outsider.it, {}, fx.client);
    assert.match(outsider.text(), /no economy account yet/);

    fx.control.failQuery = (sql) => PLAIN_READ.test(sql);
    const broken = interaction(fx, buyer);
    await assert.rejects(leaderboardCommand.execute(broken.it, {}, fx.client), (error) => {
        assert.doesNotMatch(error.userMessage ?? '', /No economy data/);
        return true;
    });
});

// ---- web: premium role setting ---------------------------------------------

test('web economy settings show which roles can be sold and refuse the others', { skip }, async (t) => {
    const { fx } = await shop(t, { premiumRoleId: role(2) });
    fx.addRole(role(2), { name: '<b>Admin</b>', permissions: ['Administrator'] });
    fx.addRole(role(4), { name: 'Tinggi', position: 70 });
    fx.addRole(role(5), { name: 'Bot lain', managed: true });
    fx.addRole(role(6), { name: 'Moderator', permissions: ['KickMembers'] });
    const req = await fx.startApi([createModulesApi]);
    const stored = async () => (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config.premiumRoleId;

    const page = await req('/settings/economy');
    assert.equal(page.status, 200);
    assert.equal(page.body.settings.premiumRoleId, role(2));
    const choices = Object.fromEntries(page.body.roles.map((x) => [x.id, x]));
    assert.deepEqual(choices[role(1)], { id: role(1), name: 'Premium', ok: true, reason: null });
    assert.equal(choices[role(2)].ok, false);
    assert.match(choices[role(2)].reason, /izin pengelolaan atau moderasi/);
    assert.match(choices[role(4)].reason, /role tertinggi bot/);
    assert.match(choices[role(6)].reason, /izin pengelolaan atau moderasi/);
    assert.equal(choices[guildId], undefined, '@everyone is not offered');
    assert.equal(choices[role(5)], undefined, 'integration roles are not offered');
    assert.deepEqual(
        { ...page.body.premiumRole, reason: null },
        { roleId: role(2), name: '<b>Admin</b>', ok: false, code: 'ROLE_DANGEROUS', reason: null },
    );
    assert.match(page.body.premiumRole.reason, /izin pengelolaan atau moderasi/);

    const refused = [
        [role(2), /izin pengelolaan atau moderasi/],
        [role(3), /tidak ada di server/],
        [role(4), /role tertinggi bot/],
        [role(5), /dikelola integrasi/],
        [role(6), /izin pengelolaan atau moderasi/],
        [guildId, /@everyone/],
    ];
    for (const [id, message] of refused) {
        const answer = await req('/settings/economy', 'PATCH', { premiumRoleId: id });
        assert.equal(answer.status, 400, id);
        assert.match(answer.body.error, /^Role premium tidak dapat dipakai: /);
        assert.match(answer.body.error, message);
    }
    for (const body of [{ premiumRoleId: 5 }, { premiumRoleId: role(1), extra: 1 }, {}]) {
        assert.equal((await req('/settings/economy', 'PATCH', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await stored(), role(2), 'a refusal stores nothing');
    assert.equal((await req('/settings/economy', 'PATCH', { premiumRoleId: role(1) }, { csrf: false })).status, 403);
    assert.equal(await stored(), role(2));

    assert.equal((await req('/settings/economy', 'PATCH', { premiumRoleId: role(1) })).status, 200);
    assert.equal(await stored(), role(1));
    const after = await req('/settings/economy');
    assert.deepEqual(after.body.premiumRole, { roleId: role(1), name: 'Premium', ok: true, code: null, reason: null });

    // The bot loses Manage Roles: the stored role is reported as unusable.
    fx.me.permissions.has = () => false;
    const lost = await req('/settings/economy');
    assert.equal(lost.body.premiumRole.code, 'BOT_NO_MANAGE_ROLES');
    assert.equal(lost.body.roles.every((x) => x.ok === false), true);

    assert.equal((await req('/settings/economy', 'PATCH', { premiumRoleId: null })).status, 200);
    assert.equal(await stored(), null);
    assert.equal((await req('/settings/economy')).body.premiumRole, null);
});

// ---- /economy dashboard -------------------------------------------------------

/** Opens `/economy dashboard` as `admin` and returns a driver for its menu. */
async function dashboard(fx, admin, { allowed = true } = {}) {
    const state = { allowed, handlers: {}, modals: [] };
    const root = interaction(fx, admin, {});
    root.it.options.getSubcommand = () => 'dashboard';
    root.it.memberPermissions = { has: () => state.allowed };
    root.it.channel = {
        createMessageComponentCollector: () => ({ on: (event, handler) => { state.handlers[event] = handler; } }),
    };
    await economyCommand.execute(root.it, {}, fx.client);

    /** Chooses a menu entry and submits the modal with `fields`. */
    async function choose(value, fields = {}) {
        const submitted = interaction(fx, admin, {});
        submitted.it.memberPermissions = { has: () => state.allowed };
        submitted.it.fields = {
            getField: (name) => ({ values: [fields[name]] }),
            getTextInputValue: (name) => String(fields[name] ?? ''),
        };
        const select = interaction(fx, admin, {});
        select.it.values = [value];
        select.it.memberPermissions = { has: () => state.allowed };
        select.it.deferUpdate = async () => { select.it.deferred = true; };
        select.it.showModal = async (modal) => { state.modals.push(modal.toJSON()); };
        select.it.awaitModalSubmit = async () => submitted.it;
        await state.handlers.collect(select.it);
        return { select, submitted, said: () => `${select.text()}\n${submitted.text()}` };
    }
    return { root, state, choose };
}

const storedCurrency = async (fx) =>
    (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config.economyCurrency ?? null;

test('/economy dashboard needs Manage Server when it opens and again on every step', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: 500 });
    const admin = fx.addMember(member(9));

    const refused = await dashboard(fx, admin, { allowed: false });
    assert.match(refused.root.text(), /Manage Server/);
    assert.equal(refused.state.handlers.collect, undefined, 'no menu is opened');

    // Permission removed after the dashboard was opened.
    const open = await dashboard(fx, admin);
    assert.match(open.root.text(), /Economy Dashboard/);
    open.state.allowed = false;
    const step = await open.choose('add_currency', { target_user: buyer.id, amount: '100', type: 'wallet' });
    assert.match(step.said(), /Manage Server/);
    assert.equal(open.state.modals.length, 0, 'the form is not even shown');
    assert.equal((await account(fx, buyer.id)).wallet, 500);

    // Permission removed while the form was open.
    const late = await dashboard(fx, admin);
    late.state.modals.push = function push(modal) {
        late.state.allowed = false;
        return Array.prototype.push.call(this, modal);
    };
    const submitted = await late.choose('add_currency', { target_user: buyer.id, amount: '100', type: 'wallet' });
    assert.match(submitted.said(), /Manage Server/);
    assert.equal((await account(fx, buyer.id)).wallet, 500);
});

test('/economy dashboard: amounts are whole numbers within a limit; totals come from one query', { skip }, async (t) => {
    const { fx, buyer } = await shop(t, { wallet: 500 });
    const admin = fx.addMember(member(9));
    const other = fx.addMember(member(2));
    await setAccount(fx, other.id, { wallet: 1_000, bank: 2_500 });

    const fetched = [];
    fx.hooks.fetchMember = (id) => { fetched.push(id); };
    const panel = await dashboard(fx, admin);
    assert.match(panel.root.text(), /Total in Circulation: `\$4,000`/);
    assert.match(panel.root.text(), /Active Users: `2`/);
    assert.match(panel.root.text(), /Average Balance: `\$2,000`/);
    assert.deepEqual(fetched, [], 'opening the dashboard asks Discord for no member');

    for (const amount of ['12abc', '1e9', '1.000', '1,000', '0', '-5', '1.5', '', '1000000000001', '9'.repeat(25)]) {
        const step = await panel.choose('add_currency', { target_user: buyer.id, amount, type: 'wallet' });
        assert.match(step.said(), /whole number from 1 to 1,000,000,000,000/, JSON.stringify(amount));
    }
    assert.match(
        (await panel.choose('remove_currency', { target_user: buyer.id, amount: '10x', type: 'wallet' })).said(),
        /whole number from 1 to/,
    );
    assert.equal((await account(fx, buyer.id)).wallet, 500, 'nothing was changed by a refused amount');

    const added = await panel.choose('add_currency', { target_user: buyer.id, amount: ' 250 ', type: 'Wallet' });
    assert.match(added.said(), /Successfully added \$250 .*\n?.*New Balance:\*\* \$750/s);
    assert.equal((await account(fx, buyer.id)).wallet, 750);

    const removed = await panel.choose('remove_currency', { target_user: buyer.id, amount: '700', type: 'wallet' });
    assert.match(removed.said(), /Successfully removed \$700/);
    assert.equal((await account(fx, buyer.id)).wallet, 50);

    // More than the member has: refused, nothing goes below zero.
    const tooMuch = await panel.choose('remove_currency', { target_user: buyer.id, amount: '51', type: 'wallet' });
    assert.doesNotMatch(tooMuch.said(), /Successfully/);
    assert.equal((await account(fx, buyer.id)).wallet, 50);

    // The totals cannot be read: say so instead of showing zero.
    fx.control.failQuery = (sql) => PLAIN_READ.test(sql);
    const blind = await dashboard(fx, admin);
    assert.match(blind.root.text(), /Total in Circulation: `unavailable`/);
    assert.doesNotMatch(blind.root.text(), /`\$0`/);
});

test('/economy dashboard stores the currency with the server settings and never edits source files', { skip }, async (t) => {
    const { fx } = await shop(t);
    const admin = fx.addMember(member(9));
    const configFile = new URL('../src/config/bot.js', import.meta.url);
    const before = fs.readFileSync(configFile, 'utf8');
    const panel = await dashboard(fx, admin);

    // Text that would have broken, or added code to, a JavaScript string literal.
    for (const symbol of ['"', '\\', "$'", '$&', '`', '";a', 'a b', '<@1', '*', 'abcd', '']) {
        const step = await panel.choose('change_currency', { currency_symbol: symbol });
        assert.match(step.said(), /1-3 letters, digits, currency signs or emoji/, JSON.stringify(symbol));
    }
    for (const name of ['"+process.exit()+"', 'a\\', '${x}', '@everyone', '**bold**', 'x'.repeat(21), '-gold', '']) {
        const step = await panel.choose('change_name', { currency_name: name });
        assert.match(step.said(), /1-20 letters, digits, spaces or hyphens/, JSON.stringify(name));
    }
    assert.equal(await storedCurrency(fx), null, 'a refused value stores nothing');

    const symbol = await panel.choose('change_currency', { currency_symbol: ' Rp ' });
    assert.match(symbol.said(), /Currency symbol changed to \*\*Rp\*\*/);
    assert.match(symbol.said(), /Other economy commands still display amounts with `\$`/);
    assert.doesNotMatch(symbol.said(), /restart/i);
    assert.deepEqual(await storedCurrency(fx), { symbol: 'Rp' });

    const name = await panel.choose('change_name', { currency_name: 'koin emas' });
    assert.match(name.said(), /Currency name changed to \*\*koin emas\*\*/);
    assert.deepEqual(await storedCurrency(fx), { symbol: 'Rp', name: 'koin emas' }, 'the symbol is kept');

    // The next dashboard shows the stored values and pre-fills the forms with them.
    const again = await dashboard(fx, admin);
    assert.match(again.root.text(), /Currency Symbol: `Rp`/);
    assert.match(again.root.text(), /Currency Name: `koin emas`/);
    assert.match(again.root.text(), /Total in Circulation: `Rp20,000`/);
    await again.choose('change_currency', { currency_symbol: 'Rp' });
    assert.equal(again.state.modals[0].components[0].components[0].value, 'Rp');

    // Other settings of the server are untouched.
    const config = (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config;
    assert.equal(config.premiumRoleId, role(1));

    assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'src/config/bot.js is not written to');
});

test('currency values kept in the settings are checked again when they are read', () => {
    assert.deepEqual(getCurrency({ economyCurrency: { symbol: '"', name: '@everyone' } }), { symbol: '$', name: 'coins' });
    assert.deepEqual(getCurrency({ economyCurrency: 'x' }), { symbol: '$', name: 'coins' });
    assert.deepEqual(getCurrency(null), { symbol: '$', name: 'coins' });
    assert.deepEqual(getCurrency({ economyCurrency: { symbol: '🪙', name: 'gold-coin' } }), { symbol: '🪙', name: 'gold-coin' });
    assert.equal(parseAdminAmount('1000000000000'), 1_000_000_000_000);
    assert.equal(parseAdminAmount(100), null);
});
