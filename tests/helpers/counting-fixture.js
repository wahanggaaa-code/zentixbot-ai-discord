import { MessageType } from 'discord.js';
import { createReactRolesFixture, guildId, memberId } from './reactroles-fixture.js';

export { guildId, memberId };
export { missingPermissions, serverError } from './reactroles-fixture.js';
export const GAME_KEY = `countingGame:${guildId}`;

/**
 * The PostgreSQL fixture and the in-memory Discord of the reaction roles tests,
 * plus what the counting game needs: messages written by members and `/count`.
 *
 * `hooks.deleteUserMessage(message)` and `hooks.react(message, emoji)` run before
 * the call takes effect and may throw. `calls.deleted` and `calls.reactions`
 * record what the bot did to members' messages; `posted()` what it managed to post.
 */
export async function createCountingFixture(t) {
    const fx = await createReactRolesFixture(t);
    const { calls, hooks, guild, client } = fx;
    calls.deleted = [];
    calls.reactions = [];
    const countChannel = fx.makeChannel({ id: '443456789012345701', name: 'counting' });
    const otherChannel = fx.makeChannel({ id: '443456789012345702', name: 'general' });
    const alice = fx.addMember(memberId(1));
    const bob = fx.addMember(memberId(2));
    const carol = fx.addMember(memberId(3));
    const manager = fx.addMember(memberId(8), [], ['ManageGuild']);
    let nextId = 850000000000000000n;

    /** A message as the gateway delivers it. */
    function message(member, content, { channel = countChannel, type = MessageType.Default, system = false, bot = false } = {}) {
        const id = String(nextId++);
        const entry = {
            id,
            content,
            type,
            system,
            guild,
            client,
            channel,
            channelId: channel.id,
            member,
            author: { ...member.user, bot },
            attachments: new Map(),
            embeds: [],
            deleted: false,
            async delete() {
                await hooks.deleteUserMessage?.(entry);
                entry.deleted = true;
                calls.deleted.push(id);
                return entry;
            },
            async react(emoji) {
                await hooks.react?.(entry, emoji);
                calls.reactions.push({ id, emoji });
            },
            reply: async (payload) => { calls.send.push({ channelId: channel.id, payload, replyTo: id }); return { id: 'reply', delete: async () => {} }; },
        };
        return entry;
    }

    // `calls.send` records every attempt; `sent` only what Discord accepted.
    const sent = [];
    for (const channel of [countChannel, otherChannel]) {
        const send = channel.send;
        channel.send = async (payload) => {
            const created = await send(payload);
            sent.push({ channelId: channel.id, payload, message: created });
            return created;
        };
    }
    /** What the bot managed to post in a channel, as plain text. */
    const posted = (channel = countChannel) => sent.filter((call) => call.channelId === channel.id)
        .map((call) => (typeof call.payload === 'string' ? call.payload : call.payload.content ?? ''));

    /** The stored game, straight from the table; `undefined` when there is no row. */
    async function stored() {
        const result = await fx.query('SELECT value FROM temp_data WHERE key = $1', [GAME_KEY]);
        return result.rows[0]?.value;
    }
    /** Store a game directly. Missing fields are left out on purpose. */
    async function seed(state = {}) {
        const value = { enabled: true, channelId: countChannel.id, system: 'decimal', nextNumber: 1, lastUserId: null, currentStreak: 0, bestStreak: 0, leaderboard: {}, ...state };
        await fx.query(
            'INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [GAME_KEY, JSON.stringify(value)],
        );
        return value;
    }

    /** A `/count …` slash command by `member`. */
    function count(options = {}, { member = manager } = {}) {
        const i = fx.command(options, { member });
        i.it.commandName = 'count';
        i.it.memberPermissions = member.permissions;
        i.it.options.getInteger = (name) => options[name] ?? null;
        i.it.options.getBoolean = (name) => options[name] ?? null;
        return i;
    }

    /** Send a member's message through the real message event. */
    const say = async (handler, member, content, options) => {
        const entry = message(member, content, options);
        await handler.execute(entry, client);
        return entry;
    };
    /** Point the server's log at the admin channel. */
    const enableLog = () => fx.query('UPDATE guilds SET config = config || $2::jsonb WHERE id = $1', [guildId, JSON.stringify({ logging: { enabled: true, channels: { audit: fx.adminChannel.id } } })]);
    /** Log entries written so far, as `{title, description}`. */
    const logEntries = () => calls.send.filter((call) => call.channelId === fx.adminChannel.id).map((call) => {
        const embed = call.payload.embeds[0].data ?? call.payload.embeds[0];
        return { title: embed.title, description: embed.description };
    });

    return { ...fx, countChannel, otherChannel, alice, bob, carol, manager, message, say, posted, sent, stored, seed, count, enableLog, logEntries };
}
