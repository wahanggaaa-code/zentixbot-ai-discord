import { createReactRolesFixture, guildId, memberId } from './reactroles-fixture.js';
import { clearAllRateLimits } from '../../src/utils/rateLimiter.js';

export { guildId, memberId };
export { missingPermissions, serverError } from './reactroles-fixture.js';

const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);

/**
 * The PostgreSQL fixture and the in-memory Discord of the reaction roles tests, plus what the
 * Utility commands need: slash commands with subcommand groups, buttons and modal submissions.
 *
 * Every interaction records `deferOptions` (what deferReply was given) and its replies.
 */
export async function createUtilityFixture(t) {
    const fx = await createReactRolesFixture(t);
    const { calls, guild } = fx;
    // Rate limits live in the process; one test must not use up the allowance of the next.
    clearAllRateLimits();
    const general = fx.makeChannel({ id: '443456789012345711', name: 'general' });
    const reports = fx.makeChannel({ id: '443456789012345712', name: 'reports' });
    const alice = fx.addMember(memberId(1));
    const bob = fx.addMember(memberId(2));
    const carol = fx.addMember(memberId(3));
    const manager = fx.addMember(memberId(8), [], ['ManageGuild']);
    guild.ownerId ??= memberId(9);

    /** Adds what the base interaction lacks and helpers to read the answer. */
    function dress(out, { channel = general } = {}) {
        const { it } = out;
        it.channel = channel;
        it.channelId = channel?.id ?? null;
        it.memberPermissions = it.member?.permissions;
        it.deferReply = async (deferOptions) => { it.deferred = true; it.deferOptions = deferOptions ?? null; };
        out.embed = () => json(out.replies.at(-1)?.embeds?.[0]) ?? {};
        /** True when the last answer can only be seen by the member who acted. */
        out.isPrivate = () => {
            const last = out.replies.at(-1);
            if (!last) return false;
            const flagged = (value) => value?.ephemeral === true || (typeof value?.flags === 'number' && (value.flags & 64) === 64);
            return it.deferred && it.deferOptions !== undefined ? flagged(it.deferOptions) : flagged(last);
        };
        /** Title, description and fields of the last answer as one text. */
        out.said = () => {
            const embed = out.embed();
            return [embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`)].filter(Boolean).join('\n');
        };
        out.buttons = () => (out.replies.at(-1)?.components ?? []).map(json).flatMap((row) => row.components ?? []).map((part) => part.custom_id);
        return out;
    }

    /**
     * A slash command. `options.group` and `options.subcommand` choose the subcommand;
     * every other entry is an option value of whatever type the command asks for.
     */
    function slash(commandName, options = {}, { member = alice, channel = general } = {}) {
        const out = fx.command(options, { member });
        const value = (name) => options[name] ?? null;
        Object.assign(out.it, { commandName });
        out.it.options = {
            getSubcommand: () => options.subcommand ?? null,
            getSubcommandGroup: () => options.group ?? null,
            getString: value, getInteger: value, getBoolean: value, getUser: value, getMember: value, getChannel: value,
        };
        return dress(out, { channel });
    }

    /** A button press on `message`. */
    function button(customId, { member = alice, message = null, channel = general } = {}) {
        const out = fx.component({ customId, member, message, type: 2 });
        return dress(out, { channel });
    }

    /**
     * A submitted modal. `message` is the message whose button opened it; `update` redraws
     * that message, as Discord does. `hooks.update(payload)` runs first and may throw.
     */
    function modal(customId, fields = {}, { member = alice, message = null, channel = general } = {}) {
        const out = fx.component({ customId, member, message, type: 2 });
        out.updates = [];
        out.it.message = message;
        out.it.isModalSubmit = () => true;
        out.it.isFromMessage = () => Boolean(message);
        out.it.fields = { getTextInputValue: (name) => fields[name] ?? '' };
        out.it.update = async (payload) => {
            await fx.hooks.update?.(payload);
            out.updates.push(payload);
            out.it.replied = true;
            if (typeof message?.edit === 'function') await message.edit(payload);
        };
        return dress(out, { channel });
    }

    /** A row of temp_data, straight from the table; `undefined` when there is none. */
    async function row(key) {
        const result = await fx.query('SELECT value FROM temp_data WHERE key = $1', [key]);
        return result.rows[0]?.value;
    }
    /** Store a row directly. */
    async function seedRow(key, value) {
        await fx.query(
            'INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [key, JSON.stringify(value)],
        );
        return value;
    }
    /** Keys of temp_data that start with `prefix`. */
    async function keys(prefix) {
        const result = await fx.query('SELECT key FROM temp_data WHERE key LIKE $1 ORDER BY key', [`${prefix.replace(/[\\%_]/g, '\\$&')}%`]);
        return result.rows.map((entry) => entry.key);
    }
    /** Replace the server's logging settings. */
    const setLogging = (logging) => fx.query(
        `INSERT INTO guilds (id, config) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET config = guilds.config || EXCLUDED.config`,
        [guildId, JSON.stringify({ logging })],
    );
    /** What the bot posted in a channel: `{content, title, description, fields}` per message. */
    const postedIn = (channel) => calls.send.filter((call) => call.channelId === channel.id).map((call) => {
        const embed = json(call.payload.embeds?.[0]) ?? {};
        return { content: call.payload.content ?? null, title: embed.title, description: embed.description, fields: embed.fields ?? [] };
    });

    return { ...fx, general, reports, alice, bob, carol, manager, slash, button, modal, row, seedRow, keys, setLogging, postedIn };
}
