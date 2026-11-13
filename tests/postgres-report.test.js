import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { createUtilityFixture, guildId } from './helpers/utility-fixture.js';
import { pgEnabled } from './helpers/leveling-postgres-fixture.js';
import { clearAllRateLimits } from '../src/utils/rateLimiter.js';
import report from '../src/commands/Utility/report.js';
import { REPORT_LIMIT } from '../src/commands/Utility/modules/report.js';

const opts = { skip: !pgEnabled };

async function setup(t) {
    const fx = await createUtilityFixture(t);
    const file = async ({ member = fx.alice, user = fx.bob.user, reason = 'spam in general' } = {}) => {
        const i = fx.slash('report', { subcommand: 'file', user, reason }, { member });
        await report.execute(i.it, {}, fx.client);
        return i;
    };
    const setChannel = async (channel, member = fx.manager) => {
        const i = fx.slash('report', { subcommand: 'setchannel', channel }, { member });
        await report.execute(i.it, {}, fx.client);
        return i;
    };
    const logging = async () => (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0]?.config?.logging;
    const reportsOn = (over = {}) => fx.setLogging({ enabled: true, channels: { reports: fx.reports.id }, enabledEvents: {}, ...over });
    return { fx, file, setChannel, logging, reportsOn };
}

test('a report is posted in the report channel and confirmed in private', opts, async (t) => {
    const { fx, file, reportsOn } = await setup(t);
    await reportsOn();
    const sent = await file({ reason: '  [click](https://evil.example) **now** @everyone  ' });
    assert.equal(sent.isPrivate(), true, 'nobody else sees who reported whom');
    assert.equal(sent.embed().title, 'Report Submitted');
    assert.match(sent.said(), /Your report against \*\*user002\*\* has been sent to the moderation team/);

    const posted = fx.postedIn(fx.reports);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].content, `<@${fx.guild.ownerId}> New report!`);
    assert.equal(posted[0].title, 'User Report');
    assert.match(posted[0].description, new RegExp(`> \\*\\*Reported User:\\*\\* user002 \\(\`${fx.bob.id}\`\\)`));
    assert.match(posted[0].description, new RegExp(`> \\*\\*Reported By:\\*\\* user001 \\(\`${fx.alice.id}\`\\)`));
    assert.match(posted[0].description, new RegExp(`> \\*\\*Channel:\\*\\* <#${fx.general.id}>`));
    const reason = posted[0].fields.find((field) => field.name === 'Reason').value;
    clearAllRateLimits();
    const named = await file({ user: { ...fx.carol.user, tag: '**loud** [x](https://evil.example)' } });
    assert.match(named.said(), /Your report against \*\*\\\*\\\*loud\\\*\\\* \\\[x\]\(https:\/\/evil\.example\)\*\* has been sent/);
    assert.match(fx.postedIn(fx.reports)[1].description, /> \*\*Reported User:\*\* \\\*\\\*loud\\\*\\\* \\\[x\]\(https:\/\/evil\.example\) \(`\d+`\)/, 'a name cannot format itself either');
    assert.equal(reason, '\\[click](https://evil.example) \\*\\*now\\*\\* @everyone', 'the reason cannot format itself or hide a link');
});

test('a report that reached nobody is not confirmed', opts, async (t) => {
    const { fx, file, reportsOn, logging } = await setup(t);
    const attempts = fx.calls.send;
    const refused = async (label) => {
        clearAllRateLimits();
        const answer = await file();
        assert.match(answer.said(), /could not be delivered, so the moderation team has \*\*not\*\* received it/, label);
        assert.doesNotMatch(answer.said(), /Report Submitted|has been sent/, label);
        assert.equal(answer.isPrivate(), true, label);
    };

    await fx.setLogging({ enabled: false, channels: { reports: fx.reports.id } });
    await refused('logging switched off');
    await reportsOn({ enabledEvents: { 'report.file': false } });
    await refused('report event switched off');
    assert.equal(attempts.length, 0, 'nothing was even tried');

    await reportsOn();
    fx.setBotPermissions(fx.reports.id, ['ViewChannel', 'SendMessages']);
    await refused('no Embed Links');
    fx.setBotPermissions(fx.reports.id, ['ViewChannel', 'EmbedLinks']);
    await refused('no Send Messages');
    assert.equal(attempts.length, 0);

    fx.setBotPermissions(fx.reports.id, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    fx.hooks.send = async () => { throw new Error('Discord 500'); };
    await refused('Discord refuses the message');
    fx.hooks.send = null;
    assert.equal(attempts.length, 1);

    await reportsOn({ channels: { reports: '443456789012345999' } });
    await refused('channel deleted');
    assert.equal((await logging()).channels.reports, '443456789012345999', 'the setting is left for a moderator to fix');

    await reportsOn();
    clearAllRateLimits();
    assert.equal((await file()).embed().title, 'Report Submitted', 'and delivered again once it works');
});

test('a report needs a channel, somebody else to report, and a reason', opts, async (t) => {
    const { fx, file, reportsOn } = await setup(t);
    const unset = await file();
    assert.match(unset.said(), /The report channel has not been set up/);
    assert.equal(unset.embed().title, 'Configuration Error');

    await reportsOn();
    const self = await file({ user: fx.alice.user });
    assert.match(self.said(), /You cannot report yourself/);
    const empty = await file({ reason: '   ' });
    assert.match(empty.said(), /Please give a reason/);
    assert.equal(fx.postedIn(fx.reports).length, 0);
    assert.equal(report.data.toJSON().dm_permission, false);
});

test('one member can file five reports in ten minutes; each one notifies the owner', opts, async (t) => {
    const { fx, file, reportsOn } = await setup(t);
    await reportsOn();
    for (let n = 1; n <= REPORT_LIMIT; n++) assert.equal((await file({ reason: `again ${n}` })).embed().title, 'Report Submitted', `report ${n}`);
    const over = await file({ reason: 'once more' });
    assert.match(over.said(), /You can file 5 reports in 10 minutes\. This report was \*\*not\*\* sent/);
    assert.equal(over.isPrivate(), true);
    assert.equal(fx.postedIn(fx.reports).length, REPORT_LIMIT);

    const other = await file({ member: fx.carol });
    assert.equal(other.embed().title, 'Report Submitted', 'another member is not held back');
    assert.equal(fx.postedIn(fx.reports).length, REPORT_LIMIT + 1);

    // A refused request does not use up the allowance.
    clearAllRateLimits();
    for (let n = 0; n < REPORT_LIMIT + 2; n++) await file({ user: fx.alice.user });
    assert.equal((await file()).embed().title, 'Report Submitted');
});

test('the report channel is only set by a manager, to a channel the bot can post in', opts, async (t) => {
    const { fx, setChannel, logging } = await setup(t);
    const member = await setChannel(fx.reports, fx.alice);
    assert.match(member.said(), /You need \*\*Manage Server\*\* permissions/);
    assert.equal(await logging(), undefined);

    for (const [flags, missing] of [[['ViewChannel'], /\*\*Send Messages\*\*, \*\*Embed Links\*\*/], [['SendMessages', 'EmbedLinks'], /\*\*View Channel\*\*/], [['ViewChannel', 'SendMessages'], /missing \*\*Embed Links\*\* there/]]) {
        fx.setBotPermissions(fx.reports.id, flags);
        const refused = await setChannel(fx.reports);
        assert.match(refused.said(), missing);
        assert.match(refused.said(), /The report channel was \*\*not\*\* changed/);
        assert.equal(await logging(), undefined, 'nothing is stored');
    }
    const voice = fx.makeChannel({ id: '443456789012345713', name: 'voice', type: ChannelType.GuildVoice });
    assert.match((await setChannel(voice)).said(), /Please choose a text channel/);
    assert.equal(await logging(), undefined);

    fx.setBotPermissions(fx.reports.id, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
    const set = await setChannel(fx.reports);
    assert.equal(set.embed().title, 'Report Channel Set');
    assert.match(set.said(), new RegExp(`All new reports will now be sent to <#${fx.reports.id}>`));
    assert.equal(set.isPrivate(), true);
    assert.equal((await logging()).channels.reports, fx.reports.id);
});

test('a save that failed is not reported as set; reports that are switched off are pointed out', opts, async (t) => {
    const { fx, file, setChannel, logging } = await setup(t);
    fx.control.failQuery = (sql) => /guilds/.test(sql) && /INSERT|UPDATE/i.test(sql);
    const failed = await setChannel(fx.reports);
    fx.control.failQuery = null;
    assert.match(failed.said(), /Could not save the channel configuration/);
    assert.doesNotMatch(failed.said(), /Report Channel Set|will now be sent/);
    assert.equal(await logging(), undefined);

    await fx.setLogging({ enabled: true, channels: { reports: null }, enabledEvents: { 'report.file': false } });
    const off = await setChannel(fx.reports);
    assert.equal(off.embed().title, 'Report Channel Set, Reports Still Off');
    assert.equal(off.embed().color, 0xFEE75C);
    assert.match(off.said(), /user reports are switched off in the logging settings, so nothing will arrive yet/);
    assert.equal((await logging()).channels.reports, fx.reports.id, 'the channel itself is stored');
    assert.match((await file()).said(), /could not be delivered/);
});
