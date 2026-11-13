import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    createTicket, closeTicket, claimTicket, unclaimTicket, reopenTicket,
    deleteTicket, performTicketDeletion, updateTicketPriority, getTicketLimit,
} from '../src/services/ticket.js';
import { getTicketData, saveTicketData } from '../src/utils/database/tickets.js';
import channelDeleteEvent from '../src/events/channelDelete.js';
import express from 'express';
import { createOperationsApi } from '../src/dashboard/operationsApi.js';
import createTicketHandler, { claimTicketHandler } from '../src/handlers/ticketButtons.js';
import { discordError } from './helpers/fake-discord-guild.js';
import {
    createTicketFixture, pgEnabled, guildId, staffId, otherStaffId, transcriptChannelId, member, ticketCode,
} from './helpers/ticket-postgres-fixture.js';

const skip = !pgEnabled;
const customIds = (message) => message.components.flatMap((row) => row.components.map((c) => c.customId));
const titles = (channel) => channel.messageList.map((m) => m.embeds[0]?.title ?? null);
const fieldValue = (message, name) => message.embeds[0].fields.find((f) => f.name === name)?.value;

async function openTicket(fx, userId = member(1)) {
    const { channel } = await createTicket(fx.guild, fx.memberOf(userId), null, 'Need help');
    return channel;
}

// ---- Storage ------------------------------------------------------------------

test('a ticket is saved only if it is still the record that was read', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channelId = fx.newId();
    const fresh = { id: channelId, guildId, userId: member(1), status: 'open', claimedBy: null };
    await saveTicketData(guildId, channelId, fresh);
    assert.deepEqual(await fx.record(channelId), fresh);

    const first = await getTicketData(guildId, channelId);
    const second = await getTicketData(guildId, channelId);
    first.claimedBy = staffId;
    await saveTicketData(guildId, channelId, first);

    // The second reader still holds the old record: its write must not erase the claim.
    second.status = 'closed';
    await assert.rejects(saveTicketData(guildId, channelId, second), { code: 'TICKET_STALE' });
    assert.equal((await fx.record(channelId)).claimedBy, staffId);
    assert.equal((await fx.record(channelId)).status, 'open');

    // The same object can be saved again after its own successful save.
    first.priority = 'high';
    await saveTicketData(guildId, channelId, first);
    assert.equal((await fx.record(channelId)).priority, 'high');

    // A record that was never read cannot replace an existing ticket.
    await assert.rejects(saveTicketData(guildId, channelId, { ...fresh, status: 'closed' }), { code: 'TICKET_STALE' });
    await assert.rejects(saveTicketData(guildId, channelId, null), { code: 'TICKET_INVALID' });
    assert.equal((await fx.record(channelId)).status, 'open');

    // A removed row is not brought back by a late save.
    const late = await getTicketData(guildId, channelId);
    await fx.pool.query('DELETE FROM ticket_data WHERE channel_id=$1', [channelId]);
    late.status = 'closed';
    await assert.rejects(saveTicketData(guildId, channelId, late), { code: 'TICKET_STALE' });
    assert.equal(await fx.record(channelId), null);
});

test('competing actions on one ticket never erase each other', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    for (let round = 0; round < 8; round++) {
        const channel = await openTicket(fx, member(100 + round));
        const [claim, close] = await Promise.allSettled([
            claimTicket(channel, fx.userOf(staffId)),
            closeTicket(channel, fx.userOf(otherStaffId), 'done'),
        ]);
        const record = await fx.record(channel.id);
        assert.ok(claim.status === 'fulfilled' || close.status === 'fulfilled', 'at least one action is applied');
        // Whatever reported success is really stored.
        if (claim.status === 'fulfilled') assert.equal(record.claimedBy, staffId);
        else assert.equal(record.claimedBy, null);
        if (close.status === 'fulfilled') assert.equal(record.status, 'closed');
        else assert.equal(record.status, 'open');
        for (const result of [claim, close]) {
            if (result.status === 'fulfilled') continue;
            const code = result.reason.context?.ticketCode;
            assert.ok(['TICKET_STALE', 'TICKET_NOT_OPEN'].includes(code), `refused with ${code}`);
            assert.match(result.reason.userMessage, /not applied|closed/);
        }
    }
});

// ---- Creation -----------------------------------------------------------------

test('creating a ticket stores a complete record and numbers tickets in order', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { ticketStaffRoleId: '600000000000000001' });
    const first = await openTicket(fx);
    const second = await openTicket(fx);
    assert.equal(first.name, 'ticket-001');
    assert.equal(second.name, 'ticket-002');

    const record = await fx.record(first.id);
    const control = first.messageList[0];
    assert.equal(record.status, 'open');
    assert.equal(record.userId, member(1));
    assert.equal(record.messageId, control.id);
    assert.equal(control.embeds[0].title, 'Ticket #001');
    assert.deepEqual(customIds(control), ['ticket_claim', 'ticket_pin', 'ticket_close']);
    assert.equal(control.pinned, true);
    assert.match(control.content, /<@&600000000000000001>/);
    assert.deepEqual([...first.permissionOverwrites.cache.keys()], [guildId, member(1), '600000000000000001']);
});

test('the per-user limit holds when one user submits several requests at once', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { maxTicketsPerUser: 2 });
    const requests = Array.from({ length: 6 }, () => createTicket(fx.guild, fx.memberOf(member(1)), null, 'x'));
    const others = [2, 3].map((n) => createTicket(fx.guild, fx.memberOf(member(n)), null, 'x'));
    const results = await Promise.allSettled(requests);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    for (const refused of results.filter((r) => r.status === 'rejected')) {
        assert.equal(refused.reason.context.ticketCode, 'TICKET_LIMIT');
        assert.match(refused.reason.userMessage, /maximum number of open tickets \(2\)/);
    }
    // Other users are not held back by it.
    assert.equal((await Promise.allSettled(others)).every((r) => r.status === 'fulfilled'), true);
    assert.equal(fx.textChannels().length, 4);
    assert.equal((await fx.records()).filter((r) => r.userId === member(1)).length, 2);

    // A failed request does not block the user's next one.
    const mine = (await fx.records()).find((r) => r.userId === member(1));
    await closeTicket(fx.channels.get(mine.id), fx.userOf(staffId), 'done');
    await createTicket(fx.guild, fx.memberOf(member(1)), null, 'again');
    assert.equal(getTicketLimit({ maxTicketsPerUser: 0 }), 3);
    assert.equal(getTicketLimit({ maxTicketsPerUser: '5' }), 3);
    assert.equal(getTicketLimit({}), 3);
    assert.equal(getTicketLimit({ maxTicketsPerUser: 7 }), 7);
});

test('a ticket that cannot be completed leaves neither a channel nor a record', { skip }, async (t) => {
    const fx = await createTicketFixture(t);

    fx.hooks.send = async () => {
        throw discordError(403, 50013, 'Missing Permissions');
    };
    await assert.rejects(openTicket(fx), ticketCode('TICKET_CREATE_FAILED'));
    assert.equal(fx.textChannels().length, 0);
    assert.deepEqual(await fx.records(), []);
    fx.hooks.send = null;

    let fail = true;
    fx.control.failQuery = (sql) => {
        if (!fail || !sql.includes('INSERT INTO ticket_data')) return false;
        fail = false;
        return true;
    };
    await assert.rejects(openTicket(fx), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_CREATE_FAILED');
        assert.match(error.userMessage, /No ticket was opened/);
        return true;
    });
    assert.equal(fx.textChannels().length, 0);
    assert.deepEqual(await fx.records(), []);

    // If the channel cannot be removed either, the user is told which channel is left over.
    fail = true;
    fx.hooks.deleteChannel = async () => {
        throw discordError(403, 50013, 'Missing Permissions');
    };
    await assert.rejects(openTicket(fx), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_CREATE_ORPHAN');
        assert.match(error.userMessage, new RegExp(`<#${fx.textChannels()[0].id}>`));
        return true;
    });
    assert.equal(fx.textChannels().length, 1);
    assert.deepEqual(await fx.records(), []);

    // Afterwards creation works again.
    fx.hooks.deleteChannel = null;
    fx.control.failQuery = null;
    const channel = await openTicket(fx);
    assert.equal((await fx.record(channel.id)).status, 'open');
});

test('open records whose channel is gone stop counting; unverifiable ones still count', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { maxTicketsPerUser: 1 });
    const goneId = fx.newId();
    await fx.insertRecord(goneId, { id: goneId, guildId, userId: member(1), status: 'open' });

    // Discord does not answer clearly: the record is left alone and the limit stands.
    fx.hooks.fetchChannel = async () => {
        throw discordError(500, 0, 'Internal Server Error');
    };
    await assert.rejects(openTicket(fx), ticketCode('TICKET_LIMIT'));
    assert.equal((await fx.record(goneId)).status, 'open');
    assert.equal(fx.textChannels().length, 0);

    // Discord says the channel does not exist: the record is marked and the user can open a ticket.
    fx.hooks.fetchChannel = null;
    const channel = await openTicket(fx);
    const stale = await fx.record(goneId);
    assert.equal(stale.status, 'deleted');
    assert.equal(stale.deletedReason, 'channel_missing');
    assert.equal((await fx.record(channel.id)).status, 'open');

    // A ticket whose channel exists keeps counting.
    await assert.rejects(openTicket(fx), ticketCode('TICKET_LIMIT'));
    assert.equal((await fx.record(channel.id)).status, 'open');
});

// ---- Close, claim, reopen -----------------------------------------------------

test('closing works once; the second attempt changes and sends nothing', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    await closeTicket(channel, fx.userOf(staffId), 'solved');

    const record = await fx.record(channel.id);
    assert.equal(record.status, 'closed');
    assert.equal(record.closedBy, staffId);
    assert.match(fieldValue(channel.messageList[0], 'Status'), /Closed/);
    assert.deepEqual(customIds(channel.messageList[0]), []);
    assert.deepEqual(titles(channel), ['Ticket #001', 'Ticket Closed']);
    assert.match(channel.messageList[1].embeds[0].description, /A DM has been sent/);
    assert.deepEqual(customIds(channel.messageList[1]), ['ticket_reopen', 'ticket_delete']);
    assert.equal(fx.dms.length, 2, 'closing notice and feedback survey');

    await assert.rejects(closeTicket(channel, fx.userOf(otherStaffId), 'again'), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_NOT_OPEN');
        assert.equal(error.userMessage, 'This ticket is already closed.');
        return true;
    });
    assert.deepEqual(await fx.record(channel.id), record);
    assert.equal(fx.dms.length, 2);
    assert.deepEqual(titles(channel), ['Ticket #001', 'Ticket Closed']);
});

test('a close that stopped half-way is completed by closing again, without a second DM', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    fx.hooks.send = async (target, payload) => {
        if ((payload.embeds?.[0]?.data ?? {}).title === 'Ticket Closed') throw discordError(500, 0, 'Internal Server Error');
    };
    await assert.rejects(closeTicket(channel, fx.userOf(staffId), 'solved'), /Ticket operation failed/);
    // The record is closed, but staff has no Reopen or Delete button yet.
    assert.equal((await fx.record(channel.id)).status, 'closed');
    assert.deepEqual(titles(channel), ['Ticket #001']);
    assert.equal(fx.dms.length, 2);

    fx.hooks.send = null;
    const closedAt = (await fx.record(channel.id)).closedAt;
    await closeTicket(channel, fx.userOf(otherStaffId), 'other reason');
    assert.deepEqual(titles(channel), ['Ticket #001', 'Ticket Closed']);
    assert.deepEqual(customIds(channel.messageList[1]), ['ticket_reopen', 'ticket_delete']);
    assert.match(channel.messageList[1].embeds[0].description, /solved/);
    const record = await fx.record(channel.id);
    assert.equal(record.closedAt, closedAt);
    assert.equal(record.closedBy, staffId);
    assert.equal(fx.dms.length, 2, 'no second DM');

    await assert.rejects(closeTicket(channel, fx.userOf(staffId), 'x'), ticketCode('TICKET_NOT_OPEN'));
    assert.deepEqual(titles(channel), ['Ticket #001', 'Ticket Closed']);
});

test('a first message that cannot be updated does not stop the close', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    const fetch = channel.messages.fetch;
    channel.messages.fetch = async () => {
        throw discordError(403, 50001, 'Missing Access');
    };
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    channel.messages.fetch = fetch;
    assert.equal((await fx.record(channel.id)).status, 'closed');
    assert.deepEqual(customIds(channel.messageList.at(-1)), ['ticket_reopen', 'ticket_delete']);
});

test('a DM that did not arrive is not reported as sent', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    fx.hooks.dm = async () => {
        throw discordError(403, 50007, 'Cannot send messages to this user');
    };
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    assert.equal((await fx.record(channel.id)).status, 'closed');
    const notice = channel.messageList.at(-1).embeds[0].description;
    assert.match(notice, /could not be notified by DM/);
    assert.doesNotMatch(notice, /A DM has been sent/);
    assert.equal(fx.dms.length, 0);

    const silent = await createTicketFixture(t, { dmOnClose: false });
    const quiet = await openTicket(silent);
    await closeTicket(quiet, silent.userOf(staffId), 'solved');
    assert.doesNotMatch(quiet.messageList.at(-1).embeds[0].description, /DM/);
    assert.equal(silent.dms.length, 0);
});

test('claim, unclaim and reopen follow the ticket state', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    const control = channel.messageList[0];

    await claimTicket(channel, fx.userOf(staffId));
    assert.equal((await fx.record(channel.id)).claimedBy, staffId);
    assert.equal(fieldValue(control, 'Claimed By'), `<@${staffId}>`);
    await assert.rejects(claimTicket(channel, fx.userOf(otherStaffId)), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_CLAIMED');
        assert.match(error.userMessage, new RegExp(`already claimed by <@${staffId}>`));
        return true;
    });

    // Someone else needs Manage Channels to release the claim.
    await assert.rejects(unclaimTicket(channel, fx.memberOf(otherStaffId)), /Cannot unclaim ticket/);
    await unclaimTicket(channel, fx.memberOf(otherStaffId, { manageChannels: true }));
    assert.equal((await fx.record(channel.id)).claimedBy, null);
    assert.equal(fieldValue(control, 'Claimed By'), 'Not claimed');

    await assert.rejects(reopenTicket(channel, fx.memberOf(staffId)), ticketCode('TICKET_NOT_CLOSED'));
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    await assert.rejects(claimTicket(channel, fx.userOf(staffId)), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_NOT_OPEN');
        assert.match(error.userMessage, /Reopen it before claiming/);
        return true;
    });
    assert.equal((await fx.record(channel.id)).claimedBy, null);

    await reopenTicket(channel, fx.memberOf(staffId));
    assert.equal((await fx.record(channel.id)).status, 'open');
    assert.equal(fieldValue(control, 'Status'), '🟢 Open');
    assert.deepEqual(customIds(control), ['ticket_claim', 'ticket_pin', 'ticket_close']);
    await claimTicket(channel, fx.userOf(staffId));
    assert.equal((await fx.record(channel.id)).claimedBy, staffId);
});

test('a long conversation does not hide the control message of a new ticket', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    const control = channel.messageList[0];
    for (let i = 0; i < 70; i++) channel.addMessage({ content: `message ${i}` }, { id: member(1), tag: 'user' });

    await closeTicket(channel, fx.userOf(staffId), 'solved');
    assert.match(fieldValue(control, 'Status'), /Closed/);
    assert.deepEqual(customIds(control), [], 'the old Claim and Close buttons are removed');

    // A ticket created before message IDs were stored is still found while it is short.
    const legacy = await openTicket(fx, member(2));
    const stored = await getTicketData(guildId, legacy.id);
    delete stored.messageId;
    await saveTicketData(guildId, legacy.id, stored);
    await claimTicket(legacy, fx.userOf(staffId));
    assert.equal(fieldValue(legacy.messageList[0], 'Claimed By'), `<@${staffId}>`);

    // If the control message was deleted by hand, the action still succeeds.
    const bare = await openTicket(fx, member(3));
    bare.messageList.splice(0, 1);
    await closeTicket(bare, fx.userOf(staffId), 'solved');
    assert.equal((await fx.record(bare.id)).status, 'closed');
});

test('a priority change records the new value', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    await updateTicketPriority(channel, 'high', fx.userOf(staffId));
    const record = await fx.record(channel.id);
    assert.equal(record.priority, 'high');
    assert.equal(record.priorityUpdatedBy, staffId);
    assert.match(channel.messageList[0].embeds[0].description, /\*\*Priority:\*\* .*High/);
    await assert.rejects(updateTicketPriority(channel, 'nonsense', fx.userOf(staffId)), /Invalid priority/);
    assert.equal((await fx.record(channel.id)).priority, 'high');
});

// ---- Deletion -----------------------------------------------------------------

test('without a transcript channel the ticket channel is deleted', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    const record = await getTicketData(guildId, channel.id);

    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), {
        deleted: true, transcript: 'not_configured',
    });
    assert.equal(fx.channels.has(channel.id), false);
    assert.equal(fx.transcripts.length, 0);
});

test('with a transcript channel the transcript arrives before the channel is deleted', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { ticketTranscriptChannelId: transcriptChannelId });
    const channel = await openTicket(fx);
    channel.addMessage({ content: 'my <b>problem</b>' }, { id: member(1), tag: 'user<1>' });
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    const record = await getTicketData(guildId, channel.id);
    fx.log.length = 0;

    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), {
        deleted: true, transcript: 'sent',
    });
    assert.deepEqual(fx.log.map((entry) => entry[0]), ['transcript', 'deleteChannel']);
    const html = fx.transcripts[0].files[0].attachment.toString('utf8');
    assert.match(html, /my &lt;b&gt;problem&lt;\/b&gt;/);
    assert.match(html, /user&lt;1&gt;/);
    assert.doesNotMatch(html, /<b>problem/);
});

test('a ticket is kept when its transcript cannot be saved', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { ticketTranscriptChannelId: transcriptChannelId });
    const channel = await openTicket(fx);
    await closeTicket(channel, fx.userOf(staffId), 'solved');
    const record = await getTicketData(guildId, channel.id);
    const kept = { deleted: false, transcript: 'failed' };

    fx.hooks.transcript = async () => {
        throw discordError(403, 50013, 'Missing Permissions');
    };
    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), kept);
    assert.equal(fx.channels.has(channel.id), true);
    const notice = channel.messageList.at(-1).embeds[0];
    assert.equal(notice.title, 'Deletion Cancelled');
    assert.match(notice.description, new RegExp(`<#${transcriptChannelId}>`));
    assert.match(notice.description, /\*\*not\*\* deleted/);

    // The configured transcript channel no longer exists.
    fx.hooks.transcript = null;
    fx.transcriptChannel.exists = false;
    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), kept);
    assert.equal(fx.channels.has(channel.id), true);

    // Settings unreadable: unknown whether a transcript is wanted, so nothing is deleted.
    let fail = true;
    fx.control.failQuery = (sql) => {
        if (!fail || !sql.includes('FROM guilds')) return false;
        fail = false;
        return true;
    };
    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), kept);
    assert.equal(fx.channels.has(channel.id), true);
    fx.control.failQuery = null;

    // Once the transcript channel works again, deletion goes through.
    fx.transcriptChannel.exists = true;
    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), {
        deleted: true, transcript: 'sent',
    });
    assert.equal(fx.channels.has(channel.id), false);
    assert.equal(fx.transcripts.length, 1);
});

test('a channel the bot cannot delete is reported in the ticket', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    const record = await getTicketData(guildId, channel.id);
    fx.hooks.deleteChannel = async () => {
        throw discordError(403, 50013, 'Missing Permissions');
    };
    assert.deepEqual(await performTicketDeletion(channel, record, fx.memberOf(staffId)), {
        deleted: false, transcript: 'not_configured',
    });
    assert.match(channel.messageList.at(-1).embeds[0].description, /could not delete this channel/);
});

test('pressing delete twice schedules one deletion', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    await closeTicket(channel, fx.userOf(staffId), 'solved');

    await deleteTicket(channel, fx.memberOf(staffId), { delayMs: 40 });
    await assert.rejects(deleteTicket(channel, fx.memberOf(otherStaffId), { delayMs: 40 }), (error) => {
        assert.equal(error.context.ticketCode, 'TICKET_DELETE_PENDING');
        assert.equal(error.userMessage, 'This ticket is already being deleted.');
        return true;
    });
    assert.equal(titles(channel).filter((title) => title === 'Ticket Deleted').length, 1);
    assert.equal(fx.channels.has(channel.id), true, 'not deleted before the delay');
    await sleep(250);
    assert.equal(fx.channels.has(channel.id), false);
    assert.equal(fx.log.filter((entry) => entry[0] === 'deleteChannel').length, 1);

    // If the announcement cannot be sent, nothing is scheduled and a retry is possible.
    const second = await openTicket(fx, member(2));
    fx.hooks.send = async () => {
        throw discordError(500, 0, 'Internal Server Error');
    };
    await assert.rejects(deleteTicket(second, fx.memberOf(staffId), { delayMs: 10 }), /Ticket operation failed/);
    fx.hooks.send = null;
    await sleep(80);
    assert.equal(fx.channels.has(second.id), true);
    await deleteTicket(second, fx.memberOf(staffId), { delayMs: 10 });
    await sleep(200);
    assert.equal(fx.channels.has(second.id), false);
});

// ---- Channel removed by hand ----------------------------------------------------

test('a ticket whose channel is deleted by hand is marked deleted', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    fx.channels.delete(channel.id);
    await channelDeleteEvent.execute({ id: channel.id, type: 0, guild: fx.guild }, fx.client);
    const record = await fx.record(channel.id);
    assert.equal(record.status, 'deleted');
    assert.ok(record.closedAt);

    // A closed ticket keeps its status, so closed-ticket statistics are not lost.
    const other = await openTicket(fx, member(2));
    await closeTicket(other, fx.userOf(staffId), 'solved');
    await channelDeleteEvent.execute({ id: other.id, type: 0, guild: fx.guild }, fx.client);
    assert.equal((await fx.record(other.id)).status, 'closed');
});

// ---- Dashboard and buttons ------------------------------------------------------

test('the dashboard explains a refused ticket action instead of a generic failure', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    const app = express();
    app.use(express.json());
    const auth = (req, res, next) => {
        req.guild = fx.guild;
        req.member = { id: staffId, user: fx.userOf(staffId) };
        next();
    };
    app.use('/api', createOperationsApi(fx.client, { auth, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const act = (action) => fetch(`http://127.0.0.1:${server.address().port}/api/tickets/${channel.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, confirmed: true }),
    });

    assert.equal((await act('claim')).status, 200);
    const again = await act('claim');
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'Tiket sudah diklaim.', code: 'TICKET_CLAIMED' });
    assert.equal((await fx.record(channel.id)).claimedBy, staffId);

    assert.equal((await act('close')).status, 200);
    assert.equal((await fx.record(channel.id)).status, 'closed');
    assert.equal((await act('close')).status, 400);
    assert.equal((await act('reopen')).status, 200);
    assert.equal((await fx.record(channel.id)).status, 'open');
});

test('a ticket button shows the reason given by the ticket service', { skip }, async (t) => {
    const fx = await createTicketFixture(t);
    const channel = await openTicket(fx);
    await claimTicket(channel, fx.userOf(staffId));

    const replies = [];
    const interaction = {
        id: fx.newId(),
        customId: 'ticket_claim',
        createdTimestamp: Date.now(),
        guildId,
        channelId: channel.id,
        channel,
        guild: fx.guild,
        client: fx.client,
        user: fx.userOf(otherStaffId),
        member: { permissions: { has: () => true }, roles: { cache: new Map() } },
        deferred: false,
        replied: false,
        inGuild: () => true,
        isRepliable: () => true,
        deferReply: async () => {
            interaction.deferred = true;
        },
        reply: async (payload) => {
            interaction.replied = true;
            replies.push(payload);
        },
        editReply: async (payload) => replies.push(payload),
        followUp: async (payload) => replies.push(payload),
    };
    await claimTicketHandler.execute(interaction, fx.client);

    const shown = JSON.stringify(replies.map((r) => (r.embeds ?? []).map((e) => e.data ?? e)));
    assert.match(shown, new RegExp(`already claimed by <@${staffId}>`));
    assert.doesNotMatch(shown, /An error occurred while claiming/);
    assert.equal((await fx.record(channel.id)).claimedBy, staffId);
});

test('the create button applies the same limit before showing the form', { skip }, async (t) => {
    const fx = await createTicketFixture(t, { maxTicketsPerUser: 1 });
    const press = async (userId) => {
        const seen = { modal: false, replies: [] };
        const interaction = {
            id: fx.newId(),
            customId: 'create_ticket',
            createdTimestamp: Date.now(),
            guildId,
            guild: fx.guild,
            client: fx.client,
            user: fx.userOf(userId),
            deferred: false,
            replied: false,
            inGuild: () => true,
            isRepliable: () => true,
            showModal: async () => {
                seen.modal = true;
            },
            reply: async (payload) => {
                interaction.replied = true;
                seen.replies.push(payload);
            },
            editReply: async (payload) => seen.replies.push(payload),
            followUp: async (payload) => seen.replies.push(payload),
        };
        await createTicketHandler.execute(interaction, fx.client);
        return { ...seen, text: JSON.stringify(seen.replies.map((r) => (r.embeds ?? []).map((e) => e.data ?? e))) };
    };

    assert.equal((await press(member(1))).modal, true);
    await openTicket(fx, member(1));
    const refused = await press(member(1));
    assert.equal(refused.modal, false);
    assert.match(refused.text, /maximum number of open tickets \(1\)/);

    // An open record whose channel is gone no longer blocks the form.
    const goneId = fx.newId();
    await fx.insertRecord(goneId, { id: goneId, guildId, userId: member(2), status: 'open' });
    assert.equal((await press(member(2))).modal, true);
    assert.equal((await fx.record(goneId)).status, 'deleted');
});
