import { EventEmitter } from 'node:events';
import { ChannelType, Collection, ComponentType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { createLevelingFixture, guildId, adminId, botId, channelId, role as roleId } from './leveling-postgres-fixture.js';
import { discordError, unknownChannel } from './fake-discord-guild.js';

export { guildId, adminId, botId, channelId, roleId };
export const unknownMessage = () => discordError(404, 10008, 'Unknown Message');
export const missingPermissions = () => discordError(403, 50013, 'Missing Permissions');
export const serverError = () => discordError(500, 0, 'Internal Server Error');
export const memberId = (n) => String(700000000000000000n + BigInt(n));

const everything = () => new PermissionsBitField(PermissionsBitField.All);
const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);

/**
 * The PostgreSQL fixture plus the Discord parts reaction roles use: text
 * channels whose messages can be sent, fetched, edited and deleted, members
 * whose roles can be given and taken, and interactions that record replies.
 *
 * `hooks` run before the Discord call takes effect and may throw or wait:
 *   hooks.send(channel, payload)        hooks.editMessage(message, payload)
 *   hooks.deleteMessage(message)        hooks.fetchMessage(channel, id)
 *   hooks.fetchChannel(id)              hooks.giveRole(member, role)
 *   hooks.takeRole(member, role)
 * `calls` records what was asked of Discord.
 */
export async function createReactRolesFixture(t) {
    const fx = await createLevelingFixture(t);
    const { guild, hooks, client } = fx;
    const channels = guild.channels.cache;
    const calls = { send: [], edit: [], delete: [], fetchMessage: [], fetchChannel: [], give: [], take: [] };
    let nextMessage = 830000000000000000n;
    const collectors = [];
    const botPermissions = new Map();

    fx.me.permissions = everything();
    guild.members.fetchMe = async () => fx.me;
    client.user = { id: botId };

    /** Permissions of the bot in a channel (default: everything). */
    const setBotPermissions = (id, flags) => botPermissions.set(id, new PermissionsBitField(flags.map((flag) => PermissionFlagsBits[flag])));

    function makeMessage(channel, payload) {
        const id = String(nextMessage++);
        const message = {
            id,
            channel,
            channelId: channel.id,
            guild,
            author: { id: botId },
            client,
            url: `https://discord.com/channels/${guildId}/${channel.id}/${id}`,
            embeds: [],
            components: [],
            async edit(next) {
                calls.edit.push({ id, payload: next });
                await hooks.editMessage?.(message, next);
                if (!channel.messages.cache.has(id)) throw unknownMessage();
                apply(message, next);
                return message;
            },
            async delete() {
                calls.delete.push({ id });
                await hooks.deleteMessage?.(message);
                if (!channel.messages.cache.has(id)) throw unknownMessage();
                channel.messages.cache.delete(id);
                await fx.onMessageDelete?.(message);
                return message;
            },
        };
        apply(message, payload);
        channel.messages.cache.set(id, message);
        return message;
    }

    function apply(message, payload) {
        if (payload.embeds) message.embeds = payload.embeds.map((embed) => ({ fields: [], ...json(embed) }));
        if (payload.components) message.components = payload.components.map(json);
    }

    function makeChannel({ id, name = 'roles', type = ChannelType.GuildText }) {
        const channel = {
            id,
            name,
            type,
            guild,
            toString: () => `<#${id}>`,
            isTextBased: () => true,
            permissionsFor: () => botPermissions.get(id) ?? everything(),
            messages: {
                cache: new Collection(),
                async fetch(query) {
                    if (typeof query !== 'string') return channel.messages.cache.clone();
                    calls.fetchMessage.push(query);
                    await hooks.fetchMessage?.(channel, query);
                    const found = channel.messages.cache.get(query);
                    if (!found) throw unknownMessage();
                    return found;
                },
            },
            async send(payload) {
                calls.send.push({ channelId: id, payload });
                await hooks.send?.(channel, payload);
                return makeMessage(channel, payload);
            },
            createMessageComponentCollector(options = {}) {
                const collector = new EventEmitter();
                collector.options = options;
                collector.ended = false;
                collector.stop = (reason = 'user') => {
                    if (collector.ended) return;
                    collector.ended = true;
                    collector.emit('end', new Collection(), reason);
                };
                collectors.push(collector);
                return collector;
            },
        };
        channels.set(id, channel);
        return channel;
    }

    // The log channel embed carries the server's name and icon.
    guild.iconURL ??= () => null;
    const panelChannel = makeChannel({ id: channelId, name: 'roles' });
    const adminChannel = makeChannel({ id: '443456789012345679', name: 'admin' });

    guild.channels.fetch = async (id) => {
        calls.fetchChannel.push(id);
        await hooks.fetchChannel?.(id);
        const found = channels.get(id);
        if (!found) throw unknownChannel();
        return found;
    };

    function addMember(id, roleIds = [], permissions = []) {
        const cache = new Collection(roleIds.map((entry) => [entry, fx.roles.get(entry) ?? { id: entry }]));
        const entry = {
            id,
            guild,
            user: { id, tag: `user${id.slice(-3)}`, username: `user${id.slice(-3)}`, displayAvatarURL: () => 'https://example.invalid/a.png' },
            permissions: new PermissionsBitField(permissions.map((flag) => PermissionFlagsBits[flag])),
            toString: () => `<@${id}>`,
            roles: {
                cache,
                add: async (target, reason) => {
                    const wanted = typeof target === 'string' ? fx.roles.get(target) ?? { id: target } : target;
                    calls.give.push({ userId: id, roleId: wanted.id, reason });
                    await hooks.giveRole?.(entry, wanted);
                    cache.set(wanted.id, wanted);
                    return entry;
                },
                remove: async (target, reason) => {
                    const wanted = typeof target === 'string' ? fx.roles.get(target) ?? { id: target } : target;
                    calls.take.push({ userId: id, roleId: wanted.id, reason });
                    await hooks.takeRole?.(entry, wanted);
                    cache.delete(wanted.id);
                    return entry;
                },
            },
        };
        fx.members.set(id, entry);
        return entry;
    }

    const admin = addMember(adminId, [], ['Administrator']);
    /** Six ordinary roles the bot may hand out: R[1] … R[6]. */
    const R = [null];
    for (let n = 1; n <= 6; n++) R.push(fx.addRole(roleId(n), { name: `Role ${n}`, position: 10 + n }));

    // ---- interactions ---------------------------------------------------------
    let nextInteraction = 910000000000000000n;
    function base(member, extra) {
        const replies = [];
        const prompts = [];
        const it = {
            id: String(nextInteraction++),
            user: member.user,
            member,
            guild,
            guildId,
            client,
            channel: adminChannel,
            channelId: adminChannel.id,
            deferred: false,
            replied: false,
            createdTimestamp: Date.now(),
            inGuild: () => true,
            deferReply: async () => { it.deferred = true; },
            deferUpdate: async () => { it.deferred = true; },
            editReply: async (payload) => { replies.push(payload); return { id: 'reply' }; },
            reply: async (payload) => { replies.push(payload); it.replied = true; },
            followUp: async (payload) => {
                replies.push(payload);
                const prompt = { id: `prompt-${nextInteraction++}` };
                prompts.push(prompt);
                return prompt;
            },
            fetchReply: async () => ({ id: `reply-${it.id}` }),
            ...extra,
        };
        const embeds = () => replies.flatMap((payload) => payload.embeds ?? []).map((embed) => json(embed));
        const text = () => embeds().map((embed) => [
            embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`), embed.footer?.text,
        ].join('\n')).join('\n');
        const last = () => {
            const embed = json(replies.at(-1)?.embeds?.[0]);
            return embed ? [embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`)].join('\n') : '';
        };
        const customIds = () => replies.flatMap((payload) => payload.components ?? []).map(json)
            .flatMap((row) => row.components ?? []).map((part) => part.custom_id);
        const colors = () => embeds().map((embed) => embed.color);
        return { it, replies, prompts, embeds, text, last, customIds, colors };
    }

    /** A `/reactroles …` slash command. */
    function command(options = {}, { member = admin } = {}) {
        return base(member, {
            commandName: 'reactroles',
            isChatInputCommand: () => true,
            options: {
                getSubcommand: () => options.subcommand ?? null,
                getString: (name) => options[name] ?? null,
                getChannel: (name) => options[name] ?? null,
                getRole: (name) => options[name] ?? null,
                getFocused: () => options.focused ?? '',
            },
        });
    }

    /** A select menu, role select or button press. `modal` answers a modal the handler shows. */
    function component({ customId, values = [], roles = [], type = ComponentType.StringSelect, member = admin, message = null, modal = undefined }) {
        const shown = [];
        const out = base(member, {
            customId,
            values,
            componentType: type,
            roles: new Collection(roles.map((entry) => [entry.id, entry])),
            message: message ?? { id: `reply-${rootId.value}` },
            isStringSelectMenu: () => type === ComponentType.StringSelect,
            isButton: () => type === ComponentType.Button,
            showModal: async (built) => { shown.push(json(built)); out.it.replied = true; },
            awaitModalSubmit: async ({ filter }) => {
                if (modal === undefined) throw new Error('modal timed out');
                const submitted = base(member, {
                    customId: shown.at(-1)?.custom_id,
                    fields: {
                        getTextInputValue: (name) => modal[name] ?? '',
                        getCheckbox: (name) => modal[name] === true,
                    },
                });
                out.modal = submitted;
                if (filter && !filter(submitted.it)) throw new Error('modal filtered');
                return submitted.it;
            },
        });
        out.shown = shown;
        return out;
    }

    const rootId = { value: null };
    /** Run `/reactroles dashboard` and remember its reply so later presses belong to it. */
    async function openDashboard(run, options = {}, who = {}) {
        const root = command({ subcommand: 'dashboard', ...options }, who);
        rootId.value = root.it.id;
        root.error = await run(root.it).then(() => null, (error) => error);
        return root;
    }

    /** Deliver a component press to the collectors that accept it. Returns how many handled it. */
    async function press(pressed, root = null) {
        if (root) pressed.it.message = { id: `reply-${root.it.id}` };
        let handled = 0;
        for (const collector of [...collectors]) {
            const { componentType, filter } = collector.options;
            if (collector.ended) continue;
            if (componentType !== undefined && componentType !== pressed.it.componentType) continue;
            if (filter && !(await filter(pressed.it))) continue;
            handled += 1;
            const listeners = collector.listeners('collect');
            if (collector.options.max === 1) collector.ended = true;
            for (const listener of listeners) await listener(pressed.it);
        }
        return handled;
    }

    /** Answer the newest follow-up prompt of `owner` (a role pick or a remove pick). */
    async function answer(owner, { customId, values = [], roles = [], type = ComponentType.StringSelect, member = admin }) {
        const picked = component({ customId, values, roles, type, member, message: { id: owner.prompts.at(-1)?.id } });
        picked.handled = await press(picked);
        return picked;
    }

    /** A member choosing roles on a posted panel. */
    function choose(message, values, member) {
        return component({ customId: 'reaction_roles', values, member, message });
    }

    const KEY = (messageId) => `guild:${guildId}:reaction_roles:${messageId}`;
    /** Stored panels by message id, straight from the table. */
    async function stored() {
        const result = await fx.query('SELECT key, value FROM temp_data WHERE key LIKE $1 ORDER BY key', [`guild:${guildId}:reaction_roles:%`]);
        return Object.fromEntries(result.rows.map((row) => [row.key.split(':').at(-1), row.value]));
    }
    /** Store a panel record directly. */
    async function store(messageId, value, key = KEY(messageId)) {
        await fx.query(
            'INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [key, JSON.stringify(value)],
        );
    }
    /** Post a panel message and store its record, without going through the command. */
    async function seedPanel(roles = [R[1], R[2]], { channel = panelChannel, title = 'Pick roles', description = 'Choose below', extra = {} } = {}) {
        const message = makeMessage(channel, {
            embeds: [{ title, description, fields: [{ name: 'Available Roles', value: roles.map((entry) => `• ${entry}`).join('\n') }] }],
            components: [{ type: 1, components: [{ type: 3, custom_id: 'reaction_roles', min_values: 0, max_values: roles.length, options: roles.map((entry) => ({ label: entry.name, value: entry.id })) }] }],
        });
        await store(message.id, { guildId, channelId: channel.id, messageId: message.id, roles: roles.map((entry) => entry.id), createdAt: new Date(0).toISOString(), ...extra });
        return message;
    }
    /** Role ids offered by the select menu of a posted panel. */
    const menuRoles = (message) => (message.components[0]?.components?.[0]?.options ?? []).map((option) => option.value);

    return {
        ...fx, calls, channels, panelChannel, adminChannel, admin, R, collectors,
        makeChannel, makeMessage, setBotPermissions, addMember,
        command, component, openDashboard, press, answer, choose,
        stored, store, seedPanel, menuRoles,
    };
}
