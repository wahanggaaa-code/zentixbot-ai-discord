import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsFixture, json } from './helpers/tools-fixture.js';
import { discordError } from './helpers/fake-discord-guild.js';
import { Collector } from 'discord.js';
import { logger } from '../src/utils/logger.js';
import embedbuilder from '../src/commands/Tools/embedbuilder.js';

/** One open builder panel of `member`, with helpers to act on it the way Discord would deliver it. */
async function open(fx, member) {
    const root = await fx.run(embedbuilder, fx.slash(member, {}));
    const session = {
        root,
        collector: fx.calls.collectors.at(-1),
        /** The member's embed and the control panel, as last shown. */
        preview: () => json(root.replies.at(-1).embeds[0]),
        panel: () => json(root.replies.at(-1).embeds[1]),
        line: (name) => session.panel().description.split('\n').find((line) => line.includes(name)),
        press: async (id) => {
            const out = fx.button(member, id, { message: root.message });
            out.taken = await fx.deliver(out);
            return out;
        },
        /** Press a button that opens a form, then submit it. */
        fill: async (buttonId, formId, fields) => {
            const press = await session.press(buttonId);
            const form = fx.modal(member, formId, fields, { message: root.message });
            form.taken = await fx.submit(form);
            return { press, form };
        },
        /** Press "Post Embed" and choose `channel` in the picker that follows. */
        post: async (channel) => {
            const press = await session.press('eb_main_post_embed');
            const choice = fx.select(member, 'eb_post_channel', [], { message: press.pickers.at(-1), picked: [channel] });
            choice.taken = await fx.deliver(choice);
            return { press, choice };
        },
    };
    return session;
}

/** The fixture, with every follow-up message of an interaction remembered as a possible picker. */
function builder(t) {
    const fx = createToolsFixture();
    const staff = fx.addMember('200000000000000020', { perms: ['ManageMessages'], name: 'staff' });
    const announcements = fx.makeChannel('300000000000000002', 'announcements');
    const button = fx.button;
    fx.button = (member, id, extra) => {
        const out = button(member, id, extra);
        out.pickers = [];
        const followUp = out.it.followUp;
        out.it.followUp = async (payload) => { const message = await followUp(payload); out.pickers.push(message); return message; };
        return out;
    };
    const infos = [];
    t.mock.method(logger, 'info', (message, meta) => infos.push({ message: String(message), meta }));
    t.mock.method(logger, 'warn', () => {});
    return { fx, staff, announcements, infos };
}

test('activity pushes back the idle timeout but never the fourteen minute limit', async (t) => {
    // discord.js keeps its own reference to the real timers, so they cannot be mocked. The clock the
    // command reads is mocked instead, and a real collector runs the same timings 400 times faster.
    t.mock.timers.enable({ apis: ['Date'] });
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    const scale = 400;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms / scale));

    class Timed extends Collector { collect() { return null; } dispose() { return null; } }
    const { time, idle } = session.collector.options;
    const timed = new Timed({}, { time: time / scale, idle: idle / scale });
    session.collector.forward = (timing) => timed.resetTimer(timing?.time === undefined ? undefined : { time: timing.time / scale });
    const closed = new Promise((resolve) => timed.once('end', (_, reason) => resolve(reason)));
    // The collector's timers are unref'd; without this the process would leave before they fire.
    const keepAlive = setInterval(() => {}, 50);
    t.after(() => { clearInterval(keepAlive); timed.stop(); });

    for (const minute of [4, 8, 12]) {
        await wait(240_000);
        t.mock.timers.setTime(minute * 60_000);
        await session.press('eb_main_toggle_timestamp');
        assert.equal(timed.ended, false, `still open at minute ${minute}`);
        assert.deepEqual(session.collector.lastReset, { time: 840_000 - minute * 60_000 });
    }
    // Two minutes after the last change: the limit, not the idle timeout, closes the panel.
    assert.equal(await closed, 'time');
});

test('the panel closes after five idle minutes, fourteen at most, and says so', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    assert.equal(session.root.isPrivate(), true);
    assert.equal(session.collector.options.idle, 300_000);
    assert.equal(session.collector.options.time, 840_000);
    assert.match(session.panel().footer.text, /Closes after 5 min of inactivity, 14 min at most/);

    // Every change counts as activity.
    const before = session.collector.resets;
    await session.press('eb_main_toggle_timestamp');
    assert.equal(session.collector.resets, before + 1);

    session.collector.stop('idle');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(session.root.replies.at(-1).content, /closed after 5 minutes without activity/);
    assert.deepEqual(session.root.replies.at(-1).components, []);

    const second = await open(fx, staff);
    second.collector.stop('time');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(second.root.replies.at(-1).content, /14 minute limit/);
});

test('two open panels do not hear each other', async (t) => {
    const { fx, staff } = builder(t);
    const first = await open(fx, staff);
    const second = await open(fx, staff);
    const press = await first.press('eb_main_toggle_timestamp');
    assert.equal(press.taken, 1, 'one collector handles the press');
    assert.equal(press.it.acknowledged, 1);
    assert.match(first.line('Timestamp'), /Enabled/);
    assert.match(second.line('Timestamp'), /Disabled/);

    // The same for the pickers: a color chosen in the picker of one panel does not reach the other.
    const colorA = await first.press('eb_main_set_color');
    const colorB = await second.press('eb_main_set_color');
    const choice = fx.select(staff, 'eb_color_pick', ['#ED4245'], { message: colorB.pickers.at(-1) });
    assert.equal(await fx.deliver(choice), 1);
    assert.match(second.line('Color'), /#ED4245/);
    assert.doesNotMatch(first.line('Color'), /#ED4245/);
    assert.equal(colorA.pickers.length, 1);
});

test('someone else pressing the buttons of a panel does nothing', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    const other = fx.button(fx.moderator, 'eb_main_toggle_timestamp', { message: session.root.message });
    assert.equal(await fx.deliver(other), 0);
    assert.match(session.line('Timestamp'), /Disabled/);
});

test('a form that was dismissed and opened again adds its field once', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    await session.press('eb_main_add_field');     // opened, then dismissed: nothing is submitted
    const { form } = await session.fill('eb_main_add_field', 'eb_add_field', { field_name: 'Rule 1', field_value: 'Be kind', field_inline: 'no' });
    assert.equal(form.taken, 2, 'both waits receive the form, as on Discord');
    assert.deepEqual(session.preview().fields, [{ name: 'Rule 1', value: 'Be kind', inline: false }]);
    assert.match(session.line('Fields'), /1 \/ 25/);
});

test('a field needs a name and a value', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    for (const fields of [{ field_name: '   ', field_value: 'x' }, { field_name: 'x', field_value: ' \n ' }]) {
        const { form } = await session.fill('eb_main_add_field', 'eb_add_field', fields);
        assert.match(form.said(), /needs both a name and a value/);
    }
    assert.match(session.line('Fields'), /0 \/ 25/);
    const { form } = await session.fill('eb_main_add_field', 'eb_add_field', { field_name: 'Side', field_value: 'by side', field_inline: 'yes' });
    assert.equal(form.replies.length, 0);
    assert.deepEqual(session.preview().fields, [{ name: 'Side', value: 'by side', inline: true }]);
});

test('author and footer can be set from the panel', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    const ids = session.root.replies.at(-1).components.flatMap((row) => json(row).components.map((c) => c.custom_id));
    assert.ok(ids.includes('eb_main_set_author') && ids.includes('eb_main_set_footer'));
    for (const row of session.root.replies.at(-1).components) assert.ok(json(row).components.length <= 5);

    await session.fill('eb_main_set_author', 'eb_author', { author_name: 'Mod team', author_icon: 'https://cdn.example/a.png', author_url: '' });
    await session.fill('eb_main_set_footer', 'eb_footer', { footer_text: 'Thanks for reading', footer_icon: '' });
    assert.deepEqual(session.preview().author, { name: 'Mod team', icon_url: 'https://cdn.example/a.png' });
    assert.deepEqual(session.preview().footer, { text: 'Thanks for reading' });
    assert.match(session.line('Author'), /Mod team/);
    assert.match(session.line('Footer'), /Thanks for reading/);

    const bad = await session.fill('eb_main_set_author', 'eb_author', { author_name: 'X', author_icon: 'javascript:alert(1)', author_url: '' });
    assert.match(bad.form.said(), /must be a valid `https:\/\/` URL/);
    assert.equal(session.preview().author.name, 'Mod team');
});

test('the embed is posted as the member wrote it: emoji, spacing, footer and timestamp', async (t) => {
    const { fx, staff, announcements, infos } = builder(t);
    const session = await open(fx, staff);
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: '🎉 Party tonight', eb_description: 'Bring:\n  - snacks 🍕\n  - two  spaces' });
    await session.fill('eb_main_set_footer', 'eb_footer', { footer_text: 'See you there', footer_icon: '' });
    await session.press('eb_main_toggle_timestamp');
    assert.match(session.line('Timestamp'), /Enabled/);
    assert.equal(session.preview().title, '🎉 Party tonight');

    const { choice } = await session.post(announcements);
    assert.equal(choice.taken, 1);
    assert.equal(fx.calls.send.length, 1);
    const sent = fx.calls.send[0];
    assert.equal(sent.channelId, announcements.id);
    const [embed] = sent.payload.embeds;
    assert.equal(embed.title, '🎉 Party tonight');
    assert.equal(embed.description, 'Bring:\n  - snacks 🍕\n  - two  spaces');
    assert.deepEqual(embed.footer, { text: 'See you there' });
    assert.match(embed.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(sent.payload.allowedMentions, { parse: [] });
    assert.match(choice.said(), /Embed Sent/);
    assert.match(choice.said(), new RegExp(`posted to <#${announcements.id}>`));

    // The embed does not name its writer; the log does.
    const line = infos.find((entry) => entry.message === 'Embed posted with the embed builder');
    assert.deepEqual(line.meta, { guildId: fx.guild.id, channelId: announcements.id, messageId: sent.message.id, userId: staff.id });
});

test('a member cannot post through the bot where they may not post themselves', async (t) => {
    const { fx, staff, infos } = builder(t);
    const locked = fx.makeChannel('300000000000000003', 'rules', { deny: { [staff.id]: ['SendMessages'] } });
    const hidden = fx.makeChannel('300000000000000004', 'staff-only', { deny: { [staff.id]: ['ViewChannel'] } });
    const session = await open(fx, staff);
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'Server rules changed', eb_description: 'Everyone must re-verify' });
    for (const channel of [locked, hidden]) {
        const { choice } = await session.post(channel);
        assert.match(choice.said(), /You need \*\*View Channel\*\*, \*\*Send Messages\*\* and \*\*Embed Links\*\*/, channel.name);
        assert.doesNotMatch(choice.said(), /Embed Sent/);
    }
    assert.equal(fx.calls.send.length, 0);
    assert.equal(infos.some((entry) => entry.message === 'Embed posted with the embed builder'), false);
});

test('posting where the bot cannot post, or into a channel that is gone, is refused', async (t) => {
    const { fx, staff } = builder(t);
    const mute = fx.makeChannel('300000000000000005', 'mute', { botPerms: ['ViewChannel'] });
    const session = await open(fx, staff);
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'Hello', eb_description: '' });
    assert.match((await session.post(mute)).choice.said(), /I need \*\*View Channel\*\*, \*\*Send Messages\*\* and \*\*Embed Links\*\*/);
    // A channel the bot does not have: the picker hands over only an id.
    assert.match((await session.post({ id: '300000000000000099' })).choice.said(), /could not find the selected channel/);
    // The channel is looked up in the server by its id; what the picker hands over is not trusted beyond that.
    const impostor = { id: mute.id, send: async () => { throw new Error('must not be used'); }, permissionsFor: () => ({ has: () => true }), toString: () => '<#impostor>' };
    assert.match((await session.post(impostor)).choice.said(), /I need \*\*View Channel\*\*, \*\*Send Messages\*\* and \*\*Embed Links\*\* in <#300000000000000005>/);
    assert.equal(fx.calls.send.length, 0);
});

test('a refusal by Discord is reported; "Embed Sent" is only said after the message exists', async (t) => {
    const { fx, staff, announcements, infos } = builder(t);
    fx.hooks.send = async () => { throw discordError(400, 50035, 'Invalid Form Body'); };
    const session = await open(fx, staff);
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'Hello', eb_description: '' });
    const { choice } = await session.post(announcements);
    assert.match(choice.said(), /Discord refused the embed/);
    assert.match(choice.said(), /nothing was posted/);
    assert.doesNotMatch(choice.said(), /Embed Sent/);
    assert.equal(infos.some((entry) => entry.message === 'Embed posted with the embed builder'), false);
});

test('an empty or oversized embed is not posted', async (t) => {
    const { fx, staff, announcements } = builder(t);
    const session = await open(fx, staff);
    const empty = await session.press('eb_main_post_embed');
    assert.match(empty.said(), /Add at least a title, description, or field/);
    assert.equal(empty.pickers.length, 0, 'no channel picker is shown');

    // Reset while the channel picker is open: the placeholder text must not be posted.
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'Hello', eb_description: '' });
    const press = await session.press('eb_main_post_embed');
    await session.press('eb_main_reset_all');
    const late = fx.select(staff, 'eb_post_channel', [], { message: press.pickers.at(-1), picked: [announcements] });
    await fx.deliver(late);
    assert.match(late.said(), /Add at least a title, description, or field/);

    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'Long', eb_description: 'd'.repeat(4000) });
    for (let n = 0; n < 3; n++) await session.fill('eb_main_add_field', 'eb_add_field', { field_name: `F${n}`, field_value: 'v'.repeat(1000) });
    const { choice } = await session.post(announcements);
    assert.match(choice.said(), /This embed has 7010 characters in total; Discord accepts at most 6000/);
    assert.equal(fx.calls.send.length, 0);
});

test('the JSON export is the embed that would be posted', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: '🎉 Hi', eb_description: 'x' });
    const press = await session.press('eb_main_json_export');
    const shown = /```json\n([\s\S]+)\n```/.exec(press.replies.at(-1).content)[1];
    assert.deepEqual(JSON.parse(shown), session.preview());
    assert.equal(JSON.parse(shown).title, '🎉 Hi');
    assert.equal(press.isPrivate(), true);

    // Too long for a message, or able to break out of the code block: a file instead.
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'T', eb_description: 'end ``` of block' });
    const asFile = await session.press('eb_main_json_export');
    assert.equal(asFile.replies.at(-1).files[0].name, 'embed.json');
    assert.deepEqual(JSON.parse(asFile.replies.at(-1).files[0].attachment.toString('utf-8')), session.preview());
    await session.fill('eb_main_edit_content', 'eb_content', { eb_title: 'T', eb_description: 'd'.repeat(3000) });
    assert.equal((await session.press('eb_main_json_export')).replies.at(-1).files.length, 1);
});

test('every button of the panel opens what it names', async (t) => {
    const { fx, staff } = builder(t);
    const session = await open(fx, staff);
    await session.fill('eb_main_add_field', 'eb_add_field', { field_name: 'One', field_value: '1' });
    await session.fill('eb_main_add_field', 'eb_add_field', { field_name: 'Two', field_value: '2' });
    for (const [id, title] of [['eb_main_set_color', 'Set Color'], ['eb_main_set_images', 'Set Images'], ['eb_main_edit_field', 'Edit Field'], ['eb_main_remove_field', 'Remove Field'], ['eb_main_reorder_fields', 'Reorder Fields']]) {
        const press = await session.press(id);
        assert.equal(press.embed().title, title, id);
        assert.equal(press.pickers.length, 1, id);
        assert.equal(press.replies.at(-1).components.length, 1, id);
    }

    // Remove the first field, through the picker of this panel.
    const remove = await session.press('eb_main_remove_field');
    assert.equal(await fx.deliver(fx.select(staff, 'eb_remove_field_pick', ['0'], { message: remove.pickers[0] })), 1);
    assert.deepEqual(session.preview().fields.map((f) => f.name), ['Two']);

    // Edit the remaining one.
    const edit = await session.press('eb_main_edit_field');
    await fx.deliver(fx.select(staff, 'eb_edit_field_pick', ['0'], { message: edit.pickers[0] }));
    assert.equal(await fx.submit(fx.modal(staff, 'eb_edit_field_modal', { field_name: 'Two!', field_value: '22', field_inline: 'yes' }, { message: edit.pickers[0] })), 1);
    assert.deepEqual(session.preview().fields, [{ name: 'Two!', value: '22', inline: true }]);

    // A picked color reaches the embed.
    const color = await session.press('eb_main_set_color');
    const offered = json(color.replies.at(-1).components[0]).components[0].options;
    assert.deepEqual(offered.map((o) => o.value), ['#336699', '#57F287', '#ED4245', '#FEE75C', '#3498DB', '#5865F2', '#EB459E', '#F1C40F', '#FFFFFF', '#202225', '__custom__']);
    for (const option of offered) assert.equal(option.emoji, undefined);
    await fx.deliver(fx.select(staff, 'eb_color_pick', ['#57F287'], { message: color.pickers[0] }));
    assert.equal(session.preview().color, 0x57F287);
});
