import { EventEmitter } from 'node:events';
import { ChannelType, Collection, PermissionsBitField } from 'discord.js';
import { clearAllRateLimits } from '../../src/utils/rateLimiter.js';
import interactionCreate from '../../src/events/interactionCreate.js';

export const guildId = '100000000000000001';
export const botId = '900000000000000001';
export const memberId = (n) => `2000000000000000${String(n).padStart(2, '0')}`;
export const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);
export const settle = () => new Promise((resolve) => setImmediate(resolve));

const MEMBER_DEFAULT = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
const BOT_DEFAULT = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory'];

/**
 * An in-memory Discord for the Tools commands. They keep nothing in a database, so this needs none.
 *
 * Every interaction (`slash`, `button`, `modal`, `select`) returns `{ it, replies, modals, message,
 * embed(), said(), isPrivate(), buttonIds() }`. `replies` holds every payload in order with the
 * method that sent it; `message` is the message the answer lives in.
 */
export function createToolsFixture() {
    // Rate limits live in the process; one test must not use up the allowance of the next.
    clearAllRateLimits();
    const calls = { send: [], edit: [], react: [], collectors: [] };
    const hooks = { send: null, edit: null, react: null };
    const members = new Collection();
    const roles = new Collection();
    const channels = new Collection();
    const guild = { id: guildId, name: 'Home', ownerId: memberId(99), memberCount: null, members: { cache: members, me: null }, roles: { cache: roles }, channels: { cache: channels } };
    let seq = 1;
    const nextId = (prefix) => `${prefix}${String(seq++).padStart(17, '0')}`;

    const addRole = (id, name, position = 1) => {
        const role = { id, name, position, toString: () => `<@&${id}>` };
        roles.set(id, role);
        return role;
    };
    const addMember = (id, { perms = [], bot = false, name = `user${id.slice(-2)}`, roles: held = [] } = {}) => {
        const user = { id, username: name, tag: name, bot, displayAvatarURL: () => `https://cdn.example/${id}.png`, toString: () => `<@${id}>` };
        const member = {
            id, user, guild,
            permissions: new PermissionsBitField(perms),
            roles: { cache: new Collection(held.map((role) => [role.id, role])) },
            toString: () => `<@${id}>`,
        };
        members.set(id, member);
        return member;
    };
    guild.members.me = addMember(botId, { bot: true, name: 'bot' });

    /** A message in a channel. `edit` and `react` are recorded in `calls`, after the matching hook. */
    const makeMessage = (channel, payload = {}) => {
        const message = {
            id: nextId('7'), channel, channelId: channel?.id ?? null,
            embeds: (payload.embeds ?? []).map(json),
            components: payload.components ?? [],
            async edit(next) {
                if (hooks.edit) await hooks.edit(message, next);
                calls.edit.push({ id: message.id, payload: next, at: Date.now() });
                if (next.embeds) message.embeds = next.embeds.map(json);
                if (next.components) message.components = next.components;
                return message;
            },
            async react(emoji) {
                if (hooks.react) await hooks.react(message, emoji);
                calls.react.push({ id: message.id, emoji });
            },
        };
        return message;
    };

    /** `deny` maps a member id to the permissions that member lacks here; `botPerms` is what the bot has here. */
    const makeChannel = (id, name, { deny = {}, botPerms = BOT_DEFAULT } = {}) => {
        const channel = {
            id, name, guild, type: ChannelType.GuildText, toString: () => `<#${id}>`,
            permissionsFor(who) {
                const whoId = who?.id ?? who;
                if (whoId === botId) return new PermissionsBitField(botPerms);
                return new PermissionsBitField(MEMBER_DEFAULT.filter((name_) => !(deny[whoId] ?? []).includes(name_)));
            },
            async send(payload) {
                if (hooks.send) await hooks.send(channel, payload);
                const message = makeMessage(channel, payload);
                calls.send.push({ channelId: id, payload, message });
                return message;
            },
            createMessageComponentCollector(options = {}) {
                const collector = new EventEmitter();
                Object.assign(collector, {
                    options, ended: false, collected: 0, resets: 0,
                    resetTimer(timing) { collector.resets += 1; collector.lastReset = timing; collector.forward?.(timing); },
                    stop(reason = 'user') { if (!collector.ended) { collector.ended = true; collector.emit('end', new Collection(), reason); } },
                });
                calls.collectors.push(collector);
                return collector;
            },
        };
        channels.set(id, channel);
        return channel;
    };
    const general = makeChannel('300000000000000001', 'general');

    // Forms a member has open: Discord gives a submitted form to every waiter whose filter accepts it.
    const waiting = [];

    function interaction(kind, { member, channel = general, options = {}, customId = null, fields = {}, values = [], message = null, picked = [] } = {}) {
        const replies = [];
        const modals = [];
        const own = makeMessage(channel);
        const record = (method, payload) => {
            replies.push({ method, ...(typeof payload === 'string' ? { content: payload } : payload) });
            if (payload?.embeds) own.embeds = payload.embeds.map(json);
            if (payload?.components) own.components = payload.components;
        };
        const it = {
            id: nextId('8'), user: member.user, member, guild, guildId, channel, channelId: channel?.id ?? null,
            client: null, createdTimestamp: Date.now(), deferred: false, replied: false, deferOptions: null,
            commandName: options.commandName ?? null, customId, values, message,
            memberPermissions: member.permissions,
            appPermissions: channel ? channel.permissionsFor(botId) : null,
            channels: new Collection(picked.map((c) => [c.id, c])),
            inGuild: () => true, isRepliable: () => true, isAutocomplete: () => false, isContextMenuCommand: () => false,
            isChatInputCommand: () => kind === 'slash', isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
            isStringSelectMenu: () => kind === 'select', isAnySelectMenu: () => kind === 'select',
            isFromMessage: () => kind === 'modal' && Boolean(message),
            options: {
                getString: (name) => options[name] ?? null, getInteger: (name) => options[name] ?? null, getNumber: (name) => options[name] ?? null,
                getBoolean: (name) => options[name] ?? null, getRole: (name) => options[name] ?? null, getSubcommand: () => options.subcommand ?? null,
            },
            fields: { getTextInputValue: (name) => fields[name] ?? '', getRadioGroup: (name) => fields[name] ?? null },
            async deferReply(deferOptions) { it.deferred = true; it.deferOptions = deferOptions ?? null; },
            async deferUpdate() { it.deferred = true; it.acknowledged = (it.acknowledged ?? 0) + 1; },
            async reply(payload) { it.replied = true; record('reply', payload); return own; },
            async editReply(payload) { record('editReply', payload); return own; },
            async fetchReply() { return own; },
            async followUp(payload) { record('followUp', payload); return makeMessage(channel, payload); },
            // A component or a form answers by changing the message it sits on.
            async update(payload) {
                it.replied = true;
                record('update', payload);
                if (message) {
                    if (payload.embeds) message.embeds = payload.embeds.map(json);
                    if (payload.components) message.components = payload.components;
                }
            },
            async showModal(modal) { it.replied = true; modals.push(json(modal)); },
            awaitModalSubmit: ({ filter }) => new Promise((resolve) => waiting.push({ filter, resolve, done: false })),
        };
        const out = { it, replies, modals, message: own };
        out.embed = () => json(replies.at(-1)?.embeds?.[0]) ?? {};
        /** Everything a member can read in the last answer. */
        out.said = () => {
            const embed = out.embed();
            return [replies.at(-1)?.content, embed.title, embed.description, ...(embed.fields ?? []).map((f) => `${f.name}: ${f.value}`), embed.footer?.text].filter(Boolean).join('\n');
        };
        /** True when the last answer can only be seen by the member who acted. */
        out.isPrivate = () => {
            const last = replies.at(-1);
            if (!last) return false;
            const flagged = (value) => value?.ephemeral === true || (typeof value?.flags === 'number' && (value.flags & 64) === 64);
            return last.method === 'editReply' ? flagged(it.deferOptions) : flagged(last);
        };
        out.buttonIds = () => (replies.at(-1)?.components ?? []).flatMap((row) => json(row).components.map((c) => c.custom_id));
        return out;
    }

    const client = { commands: new Collection(), buttons: new Collection(), selectMenus: new Collection(), modals: new Collection(), cooldowns: new Collection() };

    return {
        guild, calls, hooks, client, general,
        addMember, addRole, makeChannel, makeMessage,
        alice: addMember(memberId(1)),
        bob: addMember(memberId(2)),
        moderator: addMember(memberId(8), { perms: ['ManageMessages'] }),
        slash: (member, options = {}, extra = {}) => interaction('slash', { member, options, ...extra }),
        button: (member, customId, extra = {}) => interaction('button', { member, customId, ...extra }),
        modal: (member, customId, fields = {}, extra = {}) => interaction('modal', { member, customId, fields, ...extra }),
        select: (member, customId, values = [], extra = {}) => interaction('select', { member, customId, values, ...extra }),

        /** Run a command the way the router would after its own checks. */
        async run(command, out) {
            await command.execute(out.it, client, []);
            return out;
        },
        /** Register handler files the way the loader does (a file may export one handler or a list). */
        register(kind, ...modules) {
            for (const handler of modules.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))) client[kind].set(handler.name, handler);
        },
        /** Hand a component or form interaction to the real `interactionCreate`. */
        async route(out) {
            out.it.client = client;
            await interactionCreate.execute(out.it, client);
            return out;
        },
        /** Give a component interaction to every collector that would receive it. Returns how many took it. */
        async deliver(out) {
            const takers = calls.collectors.filter((collector) => !collector.ended && collector.options.filter(out.it));
            for (const collector of takers) {
                collector.collected += 1;
                collector.emit('collect', out.it);
                if (collector.options.max && collector.collected >= collector.options.max) collector.stop('limit');
            }
            await settle(); await settle(); await settle();
            return takers.length;
        },
        /** Submit a form. Returns how many open forms took it. */
        async submit(out) {
            const takers = waiting.filter((waiter) => !waiter.done && waiter.filter(out.it));
            for (const waiter of takers) { waiter.done = true; waiter.resolve(out.it); }
            await settle(); await settle(); await settle();
            return takers.length;
        },
    };
}
