import test from 'node:test';
import assert from 'node:assert/strict';
import { createUtilityFixture, memberId } from './helpers/utility-fixture.js';
import { pgEnabled, onSQLite, isRefused, assertCommitFailureSaid } from './helpers/leveling-postgres-fixture.js';
import todo from '../src/commands/Utility/todo.js';
import addButton, {
    sharedTodoCompleteHandler, sharedTodoRemoveHandler,
    sharedTodoAddModalHandler, sharedTodoCompleteModalHandler, sharedTodoRemoveModalHandler,
} from '../src/handlers/todoButtons.js';
import { clearAllRateLimits } from '../src/utils/rateLimiter.js';
import { MAX_LISTS_PER_MEMBER, MAX_MEMBERS, MAX_TASKS, MAX_TASK_LENGTH } from '../src/services/todo/lists.js';

const opts = { skip: !pgEnabled };
const at = new Date(0).toISOString();
const task = (id, text, extra = {}) => ({ id, text, completed: false, createdAt: at, ...extra });
const shared = (subcommand, rest = {}) => ({ group: 'share', subcommand, ...rest });
const LIST = 'abc123';
const KEY = `shared_todo_${LIST}`;

async function setup(t) {
    const fx = await createUtilityFixture(t);
    const run = async (options, who) => {
        const i = fx.slash('todo', options, who);
        await todo.execute(i.it, {}, fx.client);
        return i;
    };
    const personal = (member = fx.alice) => fx.row(`todo_${member.id}`);
    const texts = (list) => (list?.tasks ?? []).map((entry) => entry.text);
    /** A stored shared list owned by alice; `members` are added to it and to nothing else. */
    const seedShared = (over = {}) => fx.seedRow(KEY, { id: LIST, name: 'Trip', creatorId: fx.alice.id, members: [fx.alice.id, fx.bob.id], tasks: [], nextId: 1, createdAt: at, ...over });
    return { fx, run, personal, texts, seedShared };
}

// ---- personal list ------------------------------------------------------------

test('a personal list is stored per member and only its owner sees the answers', opts, async (t) => {
    const { fx, run, personal } = await setup(t);
    const added = await run({ subcommand: 'add', task: 'buy milk' });
    await run({ subcommand: 'add', task: 'call mum' });
    assert.match(added.said(), /Added #1 buy milk to your to-do list/);
    assert.equal(added.isPrivate(), true);

    const done = await run({ subcommand: 'complete', number: 1 });
    assert.match(done.said(), /Marked #1 buy milk as complete/);
    const again = await run({ subcommand: 'complete', number: 1 });
    assert.match(again.said(), /already completed/);

    const list = await run({ subcommand: 'list' });
    assert.equal(list.isPrivate(), true, 'a personal list is not posted in the channel');
    const lines = list.embed().description.split('\n');
    assert.match(lines[0], /^\*\*#1\*\* ~~buy milk~~ · done$/, 'a completed task is marked in words');
    assert.match(lines[1], /^\*\*#2\*\* call mum · <t:\d+:d>$/);
    assert.match(list.embed().description, /1 open, 1 done/);

    const stored = await personal();
    assert.deepEqual(stored.tasks.map((entry) => [entry.id, entry.text, entry.completed]), [[1, 'buy milk', true], [2, 'call mum', false]]);
    assert.equal(await personal(fx.bob), undefined, 'nothing is stored for a member who did nothing');

    const other = await run({ subcommand: 'list' }, { member: fx.bob });
    assert.match(other.said(), /Your to-do list is empty/);
    assert.equal(other.embed().title, 'Your To-Do List');
    assert.equal(await personal(fx.bob), undefined, 'looking at an empty list stores nothing');
});

test('a task number is never given out twice', opts, async (t) => {
    const { run, personal } = await setup(t);
    await run({ subcommand: 'add', task: 'one' });
    await run({ subcommand: 'add', task: 'two' });
    const removed = await run({ subcommand: 'remove', number: 2 });
    assert.match(removed.said(), /Removed #2 two from your to-do list/);
    const next = await run({ subcommand: 'add', task: 'three' });
    assert.match(next.said(), /Added #3 three/);
    assert.deepEqual((await personal()).tasks.map((entry) => entry.id), [1, 3]);

    const missing = await run({ subcommand: 'remove', number: 2 });
    assert.match(missing.said(), /Task not found/);
    const unknown = await run({ subcommand: 'complete', number: 99 });
    assert.match(unknown.said(), /Task not found/);
    assert.deepEqual((await personal()).tasks.map((entry) => entry.id), [1, 3]);
});

test('a failed read does not replace the stored list with the new task alone', opts, async (t) => {
    const { fx, run, personal, texts } = await setup(t);
    await fx.seedRow(`todo_${fx.alice.id}`, { tasks: [task(1, 'one'), task(2, 'two', { completed: true })], nextId: 3 });
    fx.control.failQuery = (sql) => /^\s*SELECT value/i.test(sql) && /temp_data/.test(sql);
    const add = await run({ subcommand: 'add', task: 'three' });
    const list = await run({ subcommand: 'list' });
    fx.control.failQuery = null;

    assert.match(add.said(), /unavailable right now\. Nothing was changed/);
    assert.doesNotMatch(add.said(), /Added/);
    assert.match(list.said(), /unavailable right now/, 'a failed read is not shown as an empty list');
    assert.doesNotMatch(list.said(), /empty/);
    assert.deepEqual(texts(await personal()), ['one', 'two']);
});

test('a failed save is never reported as done', opts, async (t) => {
    const { fx, run, personal } = await setup(t);
    const before = await fx.seedRow(`todo_${fx.alice.id}`, { tasks: [task(1, 'one')], nextId: 2 });
    fx.control.failQuery = (sql) => /INSERT INTO/i.test(sql) && /temp_data/.test(sql);
    const answers = [
        await run({ subcommand: 'add', task: 'two' }),
        await run({ subcommand: 'complete', number: 1 }),
        await run({ subcommand: 'remove', number: 1 }),
    ];
    fx.control.failQuery = null;
    for (const answer of answers) {
        assert.match(answer.said(), /Nothing was changed/);
        assert.doesNotMatch(answer.said(), /Added|Marked|Removed/);
    }
    assert.deepEqual(await personal(), before);
});

test('a commit without an answer is reported as unknown, not as done or failed', opts, async (t) => {
    const { fx, run } = await setup(t);
    fx.control.failQuery = (sql) => /^\s*COMMIT/i.test(sql);
    const add = await run({ subcommand: 'add', task: 'one' });
    fx.control.failQuery = null;
    assertCommitFailureSaid(add.said(), /may or may not have been saved/, /Nothing was changed/);
    assert.doesNotMatch(add.said(), onSQLite ? /Added #/ : /Nothing was changed|Added #/);
});

test('tasks added at the same moment are all kept', opts, async (t) => {
    const { fx, run, personal, texts, seedShared } = await setup(t);
    const answers = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => run({ subcommand: 'add', task: `task ${n}` })));
    for (const answer of answers) assert.match(answer.said(), /Added #\d task \d/);
    const stored = await personal();
    assert.deepEqual(texts(stored).sort(), ['task 0', 'task 1', 'task 2', 'task 3', 'task 4', 'task 5']);
    assert.deepEqual(stored.tasks.map((entry) => entry.id).sort(), [1, 2, 3, 4, 5, 6]);
    assert.equal(stored.nextId, 7);

    await seedShared({ members: [fx.alice.id, fx.bob.id, fx.carol.id] });
    await Promise.all([fx.alice, fx.bob, fx.carol, fx.alice, fx.bob].map((member, n) => run(shared('addtask', { list_id: LIST, task: `shared ${n}` }), { member })));
    const list = await fx.row(KEY);
    assert.deepEqual(texts(list).sort(), ['shared 0', 'shared 1', 'shared 2', 'shared 3', 'shared 4']);
    assert.equal(new Set(list.tasks.map((entry) => entry.id)).size, 5);
});

test('a list holds a limited number of tasks of limited length', opts, async (t) => {
    const { fx, run, personal } = await setup(t);
    await fx.seedRow(`todo_${fx.alice.id}`, { tasks: Array.from({ length: MAX_TASKS - 1 }, (_, n) => task(n + 1, `t${n + 1}`)), nextId: MAX_TASKS });
    const last = await run({ subcommand: 'add', task: 'x'.repeat(MAX_TASK_LENGTH) });
    assert.match(last.said(), /Added #50/);
    const over = await run({ subcommand: 'add', task: 'one too many' });
    assert.match(over.said(), /already has 50 tasks/);
    assert.equal((await personal()).tasks.length, MAX_TASKS);

    await run({ subcommand: 'remove', number: 1 });
    for (const text of ['x'.repeat(MAX_TASK_LENGTH + 1), '   ', '\u200B\u200B', '\n\t']) {
        const refused = await run({ subcommand: 'add', task: text });
        assert.match(refused.said(), /1 to 200 characters/, JSON.stringify(text.slice(0, 5)));
    }
    assert.equal((await personal()).tasks.length, MAX_TASKS - 1);

    const kept = await run({ subcommand: 'add', task: '  two   words\nhere  ' });
    assert.match(kept.said(), /Added #51 two words here/);
    assert.equal((await personal()).tasks.at(-1).text, 'two words here', 'a task is one line');
});

test('a full list of the longest tasks still fits one message, page by page', opts, async (t) => {
    const { fx, run } = await setup(t);
    // Every character needs an escape, which doubles the text.
    const worst = '*'.repeat(MAX_TASK_LENGTH);
    await fx.seedRow(`todo_${fx.alice.id}`, { tasks: Array.from({ length: MAX_TASKS }, (_, n) => task(n + 1, worst, { completed: n % 2 === 0 })), nextId: MAX_TASKS + 1 });
    const first = await run({ subcommand: 'list' });
    assert.ok(first.embed().description.length <= 4096, `description is ${first.embed().description.length} long`);
    assert.deepEqual(first.embed().description.match(/\*\*#\d+\*\*/g), Array.from({ length: 10 }, (_, n) => `**#${n + 1}**`));
    assert.match(first.embed().description, /25 open, 25 done · page 1 of 5 \(choose another with the `page` option of `\/todo list`\)$/, 'nothing was cut off the end');

    const last = await run({ subcommand: 'list', page: 5 });
    assert.match(last.embed().description, /^\*\*#41\*\*/);
    assert.match(last.embed().description, /page 5 of 5/);
    const beyond = await run({ subcommand: 'list', page: 99 });
    assert.match(beyond.embed().description, /page 5 of 5/, 'a page that does not exist shows the last one');

    await fx.seedRow(KEY, { id: LIST, name: '*'.repeat(50), creatorId: fx.alice.id, members: Array.from({ length: MAX_MEMBERS }, (_, n) => memberId(n + 1)), nextId: MAX_TASKS + 1,
        tasks: Array.from({ length: MAX_TASKS }, (_, n) => task(n + 1, worst, { completed: true, completedBy: fx.alice.id })) });
    const view = await run(shared('view', { list_id: LIST }));
    assert.ok(view.embed().description.length <= 4096, `description is ${view.embed().description.length} long`);
    assert.match(view.embed().description, /0 open, 50 done · page 1 of 5 \(choose another with the `page` option of `\/todo share view`\)$/, 'nothing was cut off the end');
    assert.ok(view.embed().fields[0].value.length <= 1024, `members field is ${view.embed().fields[0].value.length} long`);
    const lastPage = await run(shared('view', { list_id: LIST, page: 5 }));
    assert.match(lastPage.embed().description, /\n\n\*\*#41\*\* /);
    assert.match(lastPage.embed().description, /page 5 of 5/);
    assert.equal(view.embed().fields[0].name, 'Members (25)');
});

test('text of a member cannot format itself, hide a link or stay invisible', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared();
    await run(shared('addtask', { list_id: LIST, task: '[free nitro](https://evil.example) **now** `x`' }), { member: fx.bob });
    const view = await run(shared('view', { list_id: LIST }));
    const line = view.embed().description.split('\n').find((entry) => entry.startsWith('**#1**'));
    // The opening bracket is escaped, so the words are not turned into a link that hides its address.
    assert.match(line, /^\*\*#1\*\* \\\[free nitro\]\(https:\/\/evil\.example\) \\\*\\\*now\\\*\\\* \\`x\\` · <t:\d+:d>$/);
    assert.deepEqual(view.replies.at(-1).allowedMentions, { parse: [] });

    // Data written before there were limits: shown shortened, never dropped.
    await fx.seedRow(`todo_${fx.alice.id}`, { tasks: [task(1, 'y'.repeat(6000))], nextId: 2 });
    const list = await run({ subcommand: 'list' });
    const shownLine = list.embed().description.split('\n')[0];
    assert.ok(shownLine.length < 300, `line is ${shownLine.length} long`);
    assert.match(shownLine, /^\*\*#1\*\* y+… · <t:0:d>$/);
});

test('stored data that is not a list is refused and left alone', opts, async (t) => {
    const { fx, run, personal } = await setup(t);
    await fx.seedRow(`todo_${fx.alice.id}`, 'not a list');
    const add = await run({ subcommand: 'add', task: 'one' });
    assert.match(add.said(), /cannot be read, so nothing was changed/);
    assert.equal(await personal(), 'not a list');

    // Entries nobody could show or address are dropped; the next number is repaired.
    await fx.seedRow(`todo_${fx.bob.id}`, { tasks: [task(4, 'kept'), { id: 'x', text: 'no number' }, task(4, 'same number'), { id: 5 }, null, task(6, '   ')], nextId: 2 });
    const list = await run({ subcommand: 'list' }, { member: fx.bob });
    assert.deepEqual(list.embed().description.match(/\*\*#\d+\*\*/g), ['**#4**']);
    const next = await run({ subcommand: 'add', task: 'new' }, { member: fx.bob });
    assert.match(next.said(), /Added #5 new/);
    assert.deepEqual((await personal(fx.bob)).tasks.map((entry) => [entry.id, entry.text]), [[4, 'kept'], [5, 'new']]);
});

// ---- shared lists ---------------------------------------------------------------

test('a shared list is created with an id, listed for its members and viewed in private', opts, async (t) => {
    const { fx, run } = await setup(t);
    const created = await run(shared('create', { name: '  Trip  to **Bali** ' }));
    const id = /`([0-9a-f]{32})`/.exec(created.embed().description)?.[1];
    assert.ok(id, created.said());
    assert.equal(created.isPrivate(), true);
    assert.match(created.said(), /Created the shared list \*\*Trip to \\\*\\\*Bali\\\*\\\*\*\*/);

    const stored = await fx.row(`shared_todo_${id}`);
    assert.deepEqual([stored.name, stored.creatorId, stored.members, stored.tasks, stored.nextId], ['Trip to **Bali**', fx.alice.id, [fx.alice.id], [], 1]);
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.alice.id}`), [id]);

    const lists = await run(shared('lists'));
    assert.equal(lists.isPrivate(), true);
    assert.match(lists.said(), new RegExp(`\`${id}\``));
    assert.match(lists.said(), /0 open of 0 · 1 member · owner/);
    assert.match((await run(shared('lists'), { member: fx.bob })).said(), /You are not in any shared list/);

    const view = await run(shared('view', { list_id: id }));
    assert.equal(view.isPrivate(), true, 'a shared list is shown to the member alone unless asked otherwise');
    assert.deepEqual(view.buttons(), [`shared_todo_add_${id}`, `shared_todo_complete_${id}`, `shared_todo_remove_${id}`]);
    assert.match(view.said(), new RegExp(`ID: \`${id}\`\nOwner: <@${fx.alice.id}>`));
    assert.ok(view.embed().description.startsWith('**Trip to \\*\\*Bali\\*\\***\n'), 'the name cannot format itself');
    assert.match(lists.said(), /\*\*Trip to \\\*\\\*Bali\\\*\\\*\*\* · `/);
    assert.match(view.said(), /This list is empty/);
    assert.match(view.said(), new RegExp(`Members \\(1\\): <@${fx.alice.id}>`));

    const open = await run(shared('view', { list_id: id, public: true }));
    assert.equal(open.isPrivate(), false, 'posted in the channel on request');

    for (const name of ['', '   ', 'n'.repeat(51)]) {
        const refused = await run(shared('create', { name }));
        assert.match(refused.said(), /1 to 50 for a list name/);
    }
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.alice.id}`), [id]);
});

test('only the owner adds and removes members; a member can leave', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared({ members: [fx.alice.id] });
    const members = async () => (await fx.row(KEY)).members;

    const byStranger = await run(shared('add', { list_id: LIST, user: fx.carol.user }), { member: fx.bob });
    assert.match(byStranger.said(), /You don't have access to this list/);
    const bot = await run(shared('add', { list_id: LIST, user: { id: memberId(70), bot: true } }));
    assert.match(bot.said(), /A bot cannot be a member/);
    assert.deepEqual(await members(), [fx.alice.id]);

    const added = await run(shared('add', { list_id: LIST, user: fx.bob.user }));
    assert.match(added.said(), new RegExp(`<@${fx.bob.id}> can now see and change the shared list \\*\\*Trip\\*\\*`));
    assert.deepEqual(await members(), [fx.alice.id, fx.bob.id]);
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.bob.id}`), [LIST]);
    assert.match((await run(shared('add', { list_id: LIST, user: fx.bob.user }))).said(), /already a member/);

    // A member who is not the owner changes tasks, not members.
    const byMember = await run(shared('add', { list_id: LIST, user: fx.carol.user }), { member: fx.bob });
    assert.match(byMember.said(), /Only the owner of the list can do that/);
    const kick = await run(shared('removemember', { list_id: LIST, user: fx.alice.user }), { member: fx.bob });
    assert.match(kick.said(), /Only the owner/);
    const wipe = await run(shared('delete', { list_id: LIST }), { member: fx.bob });
    assert.match(wipe.said(), /Only the owner/);
    assert.deepEqual(await members(), [fx.alice.id, fx.bob.id]);
    assert.match((await run(shared('lists'), { member: fx.bob })).said(), new RegExp(`shared by <@${fx.alice.id}>`));

    assert.match((await run(shared('leave', { list_id: LIST }))).said(), /The owner cannot leave or be removed/);
    assert.match((await run(shared('removemember', { list_id: LIST, user: fx.alice.user }))).said(), /The owner cannot leave or be removed/);
    assert.match((await run(shared('removemember', { list_id: LIST, user: fx.carol.user }))).said(), /not a member of this list/);

    const left = await run(shared('leave', { list_id: LIST }), { member: fx.bob });
    assert.match(left.said(), /You left the shared list \*\*Trip\*\*/);
    assert.deepEqual(await members(), [fx.alice.id]);
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.bob.id}`), []);
    assert.match((await run(shared('view', { list_id: LIST }), { member: fx.bob })).said(), /You don't have access/);

    await run(shared('add', { list_id: LIST, user: fx.carol.user }));
    const removed = await run(shared('removemember', { list_id: LIST, user: fx.carol.user }));
    assert.match(removed.said(), new RegExp(`<@${fx.carol.id}> no longer has access`));
    assert.deepEqual(await members(), [fx.alice.id]);
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.carol.id}`), []);
});

test('somebody who is not a member can neither read nor change a shared list', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    const before = await seedShared({ tasks: [task(1, 'secret plan')], nextId: 2 });
    const attempts = [
        shared('view', { list_id: LIST }), shared('view', { list_id: LIST, public: true }), shared('addtask', { list_id: LIST, task: 'mine' }),
        shared('complete', { list_id: LIST, number: 1 }), shared('remove', { list_id: LIST, number: 1 }),
        shared('leave', { list_id: LIST }), shared('delete', { list_id: LIST }),
        shared('add', { list_id: LIST, user: fx.carol.user }), shared('removemember', { list_id: LIST, user: fx.bob.user }),
    ];
    for (const options of attempts) {
        const answer = await run(options, { member: fx.carol });
        assert.match(answer.said(), /You don't have access to this list/, options.subcommand);
        assert.doesNotMatch(answer.said(), /secret plan|Trip/, options.subcommand);
        assert.deepEqual(answer.buttons(), [], options.subcommand);
    }
    assert.deepEqual(await fx.row(KEY), before);
    assert.equal(await fx.row(`user_shared_lists_${fx.carol.id}`), undefined);

    assert.match((await run(shared('view', { list_id: 'ffffffffffffffffffffffffffffffff' }))).said(), /Shared list not found/);
    let queries = 0;
    fx.control.failQuery = () => { queries += 1; return false; };
    for (const id of ['abc_123', 'a b', "x' OR 1=1", 'é', 'x'.repeat(65), '']) {
        for (const options of [shared('view', { list_id: id }), shared('addtask', { list_id: id, task: 'x' }), shared('delete', { list_id: id }), shared('leave', { list_id: id })]) {
            const answer = await run(options);
            assert.match(answer.said(), /not a valid shared list ID/, `${options.subcommand} ${JSON.stringify(id)}`);
        }
    }
    fx.control.failQuery = null;
    assert.equal(queries, 0, 'an id that cannot exist is not looked up');
});

test('tasks of a shared list record who added and completed them', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared();
    const added = await run(shared('addtask', { list_id: LIST, task: 'pack' }), { member: fx.bob });
    assert.match(added.said(), /Added #1 pack to the shared list \*\*Trip\*\*/);
    assert.equal(added.isPrivate(), true);
    await run(shared('addtask', { list_id: LIST, task: 'book' }));

    const done = await run(shared('complete', { list_id: LIST, number: 1 }));
    assert.match(done.said(), /Marked #1 pack as complete in the shared list \*\*Trip\*\*/);
    assert.match((await run(shared('complete', { list_id: LIST, number: 1 }), { member: fx.bob })).said(), /already completed/);
    assert.match((await run(shared('complete', { list_id: LIST, number: 7 }))).said(), /Task not found/);

    const stored = await fx.row(KEY);
    assert.deepEqual(stored.tasks.map((entry) => [entry.id, entry.text, entry.completed, entry.createdBy, entry.completedBy]), [
        [1, 'pack', true, fx.bob.id, fx.alice.id], [2, 'book', false, fx.alice.id, undefined],
    ]);
    const view = await run(shared('view', { list_id: LIST }), { member: fx.bob });
    assert.match(view.embed().description, new RegExp(`\\*\\*#1\\*\\* ~~pack~~ · done by <@${fx.alice.id}>\n\\*\\*#2\\*\\* book · <t:\\d+:d>\n\n1 open, 1 done`));

    const removed = await run(shared('remove', { list_id: LIST, number: 1 }), { member: fx.bob });
    assert.match(removed.said(), /Removed #1 pack from the shared list/);
    assert.deepEqual((await fx.row(KEY)).tasks.map((entry) => entry.id), [2]);
});

test('deleting a shared list removes it for everybody; the list of lists shows only real memberships', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared({ tasks: [task(1, 'a'), task(2, 'b')], nextId: 3 });
    await fx.seedRow(`user_shared_lists_${fx.alice.id}`, [LIST]);
    // bob's index: the real list, a list that never existed, and a list he is not a member of.
    await fx.seedRow('shared_todo_other1', { id: 'other1', name: 'Not Mine', creatorId: fx.carol.id, members: [fx.carol.id], tasks: [], nextId: 1 });
    await fx.seedRow(`user_shared_lists_${fx.bob.id}`, [LIST, 'gone999', 'other1', 42, 'bad id']);

    const mine = await run(shared('lists'), { member: fx.bob });
    assert.match(mine.said(), /\*\*Trip\*\* · `abc123`\n2 open of 2 · 2 members/);
    assert.doesNotMatch(mine.said(), /Not Mine|gone999|other1/);

    const deleted = await run(shared('delete', { list_id: LIST }));
    assert.match(deleted.said(), /Deleted the shared list \*\*Trip\*\* and its 2 tasks for all members/);
    assert.equal(await fx.row(KEY), undefined);
    assert.match((await run(shared('lists'), { member: fx.bob })).said(), /You are not in any shared list/);
    assert.match((await run(shared('view', { list_id: LIST }), { member: fx.bob })).said(), /Shared list not found/);
    assert.match((await run(shared('addtask', { list_id: LIST, task: 'late' }), { member: fx.bob })).said(), /Shared list not found/);
    assert.equal(await fx.row(KEY), undefined, 'a deleted list is not created again by a late task');

    // The next write of an index drops what is not a membership.
    const created = await run(shared('create', { name: 'Fresh' }), { member: fx.bob });
    const id = /`([0-9a-f]{32})`/.exec(created.embed().description)[1];
    assert.deepEqual(await fx.row(`user_shared_lists_${fx.bob.id}`), [id]);
});

test('members and lists per member are limited', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared({ members: Array.from({ length: MAX_MEMBERS }, (_, n) => (n === 0 ? fx.alice.id : memberId(100 + n))) });
    const full = await run(shared('add', { list_id: LIST, user: fx.carol.user }));
    assert.match(full.said(), /already has 25 members/);
    assert.equal((await fx.row(KEY)).members.length, MAX_MEMBERS);

    // dave is in as many lists as allowed.
    const dave = fx.addMember(memberId(4));
    const ids = Array.from({ length: MAX_LISTS_PER_MEMBER }, (_, n) => `full${n}`);
    for (const id of ids) await fx.seedRow(`shared_todo_${id}`, { id, name: id, creatorId: dave.id, members: [dave.id], tasks: [], nextId: 1 });
    await fx.seedRow(`user_shared_lists_${dave.id}`, ids);
    const more = await run(shared('create', { name: 'One more' }), { member: dave });
    assert.match(more.said(), /at most 25 shared lists/);
    assert.equal((await fx.keys('shared_todo_')).length, MAX_LISTS_PER_MEMBER + 1);

    await seedShared({ members: [fx.alice.id] });
    const invite = await run(shared('add', { list_id: LIST, user: dave.user }));
    assert.match(invite.said(), /at most 25 shared lists/);
    assert.deepEqual((await fx.row(KEY)).members, [fx.alice.id]);
    assert.deepEqual(await fx.row(`user_shared_lists_${dave.id}`), ids);
});

test('adding a member is all or nothing', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    const before = await seedShared({ members: [fx.alice.id] });
    // Two rows are written: the index of the new member and the list. The second write fails,
    // so the first one has to be taken back.
    let writes = 0;
    fx.control.failQuery = (sql) => /INSERT INTO/i.test(sql) && /temp_data/.test(sql) && ++writes === 2;
    const answer = await run(shared('add', { list_id: LIST, user: fx.bob.user }));
    fx.control.failQuery = null;
    assert.equal(writes, 2);
    assert.match(answer.said(), /Nothing was changed/);
    assert.deepEqual(await fx.row(KEY), before);
    assert.equal(await fx.row(`user_shared_lists_${fx.bob.id}`), undefined);
});

// ---- buttons and forms ------------------------------------------------------------

test('the buttons open their form for members only', opts, async (t) => {
    const { fx, seedShared } = await setup(t);
    await seedShared();
    assert.deepEqual([addButton.name, sharedTodoCompleteHandler.name, sharedTodoRemoveHandler.name], ['shared_todo_add', 'shared_todo_complete', 'shared_todo_remove']);
    assert.deepEqual([sharedTodoAddModalHandler.name, sharedTodoCompleteModalHandler.name, sharedTodoRemoveModalHandler.name], ['shared_todo_add_modal', 'shared_todo_complete_modal', 'shared_todo_remove_modal']);

    for (const [handler, kind, field] of [[addButton, 'add', 'task_text'], [sharedTodoCompleteHandler, 'complete', 'task_id'], [sharedTodoRemoveHandler, 'remove', 'task_id']]) {
        const press = fx.button(`shared_todo_${kind}_${LIST}`, { member: fx.bob });
        await handler.execute(press.it, fx.client, [LIST]);
        assert.equal(press.shown.length, 1, kind);
        assert.equal(press.shown[0].custom_id, `shared_todo_${kind}_modal:${LIST}`);
        assert.equal(press.shown[0].components[0].components[0].custom_id, field);

        const stranger = fx.button(`shared_todo_${kind}_${LIST}`, { member: fx.carol });
        await handler.execute(stranger.it, fx.client, [LIST]);
        assert.equal(stranger.shown.length, 0, `${kind}: no form for somebody without access`);
        assert.match(stranger.said(), /You don't have access to this list/);

        const bad = fx.button(`shared_todo_${kind}_x`, { member: fx.bob });
        await handler.execute(bad.it, fx.client, ['a b']);
        assert.equal(bad.shown.length, 0);
        assert.match(bad.said(), /not a valid shared list ID/);
    }
    const press = fx.button(`shared_todo_add_${LIST}`, { member: fx.bob });
    await addButton.execute(press.it, fx.client, [LIST]);
    const limit = press.shown[0].components[0].components[0].max_length;
    assert.equal(limit, MAX_TASK_LENGTH);
});

test('a submitted form changes the list and redraws the message it came from', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared();
    const posted = await run(shared('view', { list_id: LIST, public: true }));
    const message = fx.makeMessage(fx.general, posted.replies.at(-1));
    const description = () => message.embeds[0].description;

    const add = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: 'pack **bags**' }, { member: fx.bob, message });
    await sharedTodoAddModalHandler.execute(add.it, fx.client, [LIST]);
    assert.equal(add.updates.length, 1);
    assert.match(description(), /\*\*#1\*\* pack \\\*\\\*bags\\\*\\\* · <t:\d+:d>/);
    assert.match(add.said(), /Added #1 pack \\\*\\\*bags\\\*\\\* to the shared list/);
    assert.equal(add.isPrivate(), true, 'the confirmation is for the member alone');

    // The id of a form made before this change carried the message id as a third part.
    const done = fx.modal(`shared_todo_complete_modal:${LIST}:${message.id}`, { task_id: ' #1 ' }, { member: fx.alice, message });
    await sharedTodoCompleteModalHandler.execute(done.it, fx.client, [LIST, message.id]);
    assert.match(description(), new RegExp(`\\*\\*#1\\*\\* ~~pack \\\\\\*\\\\\\*bags\\\\\\*\\\\\\*~~ · done by <@${fx.alice.id}>`));
    assert.match(done.said(), /Marked #1/);

    // Only a whole number names a task; "1.5" is not task 1.
    for (const value of ['abc', '0', '-1', '1.5', '1 2', '', '99999999999']) {
        clearAllRateLimits();
        const bad = fx.modal(`shared_todo_remove_modal:${LIST}`, { task_id: value }, { member: fx.alice, message });
        await sharedTodoRemoveModalHandler.execute(bad.it, fx.client, [LIST]);
        assert.equal(bad.updates.length, 0, JSON.stringify(value));
        assert.match(bad.said(), /Task not found/, JSON.stringify(value));
        assert.equal(bad.isPrivate(), true);
    }
    assert.equal((await fx.row(KEY)).tasks.length, 1);

    const gone = fx.modal(`shared_todo_remove_modal:${LIST}`, { task_id: '1' }, { member: fx.bob, message });
    await sharedTodoRemoveModalHandler.execute(gone.it, fx.client, [LIST]);
    assert.match(description(), /This list is empty/);
    assert.deepEqual((await fx.row(KEY)).tasks, []);
});

test('after a form the message shows the page of the task that changed', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared({ tasks: Array.from({ length: 12 }, (_, n) => task(n + 1, `t${n + 1}`)), nextId: 13 });
    const posted = await run(shared('view', { list_id: LIST, public: true }));
    const message = fx.makeMessage(fx.general, posted.replies.at(-1));
    const numbers = () => message.embeds[0].description.match(/\*\*#\d+\*\*/g).join(' ');
    assert.equal(numbers(), '**#1** **#2** **#3** **#4** **#5** **#6** **#7** **#8** **#9** **#10**');

    const add = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: 'thirteenth' }, { member: fx.bob, message });
    await sharedTodoAddModalHandler.execute(add.it, fx.client, [LIST]);
    assert.equal(numbers(), '**#11** **#12** **#13**', 'the new task is on the second page');
    assert.match(message.embeds[0].description, /page 2 of 2/);

    const done = fx.modal(`shared_todo_complete_modal:${LIST}`, { task_id: '3' }, { member: fx.bob, message });
    await sharedTodoCompleteModalHandler.execute(done.it, fx.client, [LIST]);
    assert.match(message.embeds[0].description, /^[^]*\*\*#3\*\* ~~t3~~ · done by/);
    assert.match(message.embeds[0].description, /page 1 of 2/);
    assert.deepEqual(message.components.flatMap((row) => row.components).map((part) => part.custom_id), [`shared_todo_add_${LIST}`, `shared_todo_complete_${LIST}`, `shared_todo_remove_${LIST}`], 'the buttons stay');
});

test('a form changes nothing for somebody without access and never redraws a foreign message', opts, async (t) => {
    const { fx, seedShared } = await setup(t);
    const before = await seedShared();
    const giveaway = fx.makeMessage(fx.general, { embeds: [{ title: 'Giveaway', description: 'Win a prize' }], components: [] });

    const stranger = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: 'gotcha' }, { member: fx.carol, message: giveaway });
    await sharedTodoAddModalHandler.execute(stranger.it, fx.client, [LIST]);
    assert.match(stranger.said(), /You don't have access to this list/);
    assert.deepEqual(await fx.row(KEY), before);

    // A member, but the form claims to belong to a message that does not show this list.
    const other = await fx.seedRow('shared_todo_other1', { id: 'other1', name: 'Other', creatorId: fx.bob.id, members: [fx.bob.id], tasks: [], nextId: 1 });
    const foreignView = fx.makeMessage(fx.general, { embeds: [{ title: 'Shared To-Do List', description: 'Other' }], components: [{ type: 1, components: [{ type: 2, custom_id: 'shared_todo_add_other1' }] }] });
    const notOurs = { ...fx.makeMessage(fx.general, { embeds: [{ title: 'Looks like a list' }], components: [{ type: 1, components: [{ type: 2, custom_id: `shared_todo_add_${LIST}` }] }] }), author: { id: memberId(66) } };
    for (const message of [giveaway, foreignView, notOurs, null]) {
        const member = fx.modal(`shared_todo_add_modal:${LIST}:${message?.id ?? ''}`, { task_text: 'real task' }, { member: fx.bob, message });
        await sharedTodoAddModalHandler.execute(member.it, fx.client, [LIST, message?.id]);
        assert.equal(member.updates.length, 0, 'no redraw');
        assert.match(member.said(), /Added #\d real task/, 'the change itself is made and confirmed');
        assert.equal(member.isPrivate(), true);
    }
    assert.equal(giveaway.embeds[0].title, 'Giveaway');
    assert.equal(foreignView.embeds[0].description, 'Other');
    assert.equal(fx.calls.edit.length, 0);
    assert.deepEqual(await fx.row('shared_todo_other1'), other);
    assert.equal((await fx.row(KEY)).tasks.length, 4);
});

test('forms are limited to five per half minute and kind', opts, async (t) => {
    const { fx, seedShared } = await setup(t);
    await seedShared();
    const submit = async (n, member = fx.bob) => {
        const form = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: `task ${n}` }, { member });
        await sharedTodoAddModalHandler.execute(form.it, fx.client, [LIST]);
        return form;
    };
    for (let n = 1; n <= 5; n++) assert.match((await submit(n)).said(), new RegExp(`Added #${n} task ${n}`));
    const sixth = await submit(6);
    assert.match(sixth.said(), /adding tasks too quickly/);
    assert.equal((await fx.row(KEY)).tasks.length, 5, 'the sixth is not stored');
    assert.match((await submit(7, fx.alice)).said(), /Added #6 task 7/, 'another member is not held back');
});

test('a redraw that fails does not undo or deny the change; a storage failure does not claim it', opts, async (t) => {
    const { fx, run, seedShared } = await setup(t);
    await seedShared();
    const posted = await run(shared('view', { list_id: LIST, public: true }));
    const message = fx.makeMessage(fx.general, posted.replies.at(-1));

    fx.hooks.update = async () => { throw new Error('Unknown Message'); };
    const add = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: 'kept' }, { member: fx.bob, message });
    await sharedTodoAddModalHandler.execute(add.it, fx.client, [LIST]);
    fx.hooks.update = null;
    assert.match(add.said(), /Added #1 kept/);
    assert.deepEqual((await fx.row(KEY)).tasks.map((entry) => entry.text), ['kept']);

    fx.control.failQuery = (sql) => /INSERT INTO/i.test(sql) && /temp_data/.test(sql);
    const failed = fx.modal(`shared_todo_add_modal:${LIST}`, { task_text: 'lost' }, { member: fx.bob, message });
    await sharedTodoAddModalHandler.execute(failed.it, fx.client, [LIST]);
    fx.control.failQuery = (sql) => /^\s*SELECT value/i.test(sql) && /temp_data/.test(sql);
    const press = fx.button(`shared_todo_add_${LIST}`, { member: fx.bob, message });
    await addButton.execute(press.it, fx.client, [LIST]);
    fx.control.failQuery = null;
    assert.match(failed.said(), /Nothing was changed/);
    assert.equal(failed.updates.length, 0);
    assert.match(press.said(), /unavailable right now/);
    assert.equal(press.shown.length, 0);
    assert.deepEqual((await fx.row(KEY)).tasks.map((entry) => entry.text), ['kept']);
});

test('to-do rows can only be written by the to-do store', opts, async (t) => {
    const { fx, run, personal } = await setup(t);
    await run({ subcommand: 'add', task: 'one' });
    const before = await personal();
    for (const key of [`todo_${fx.alice.id}`, KEY, `user_shared_lists_${fx.alice.id}`]) {
        assert.equal(await isRefused(fx.client.db.set(key, { tasks: [] })), true, key);
        assert.equal(await isRefused(fx.client.db.delete(key)), true, key);
    }
    assert.deepEqual(await personal(), before);
    assert.equal(await fx.row(KEY), undefined);
    assert.deepEqual(await fx.client.db.get(`todo_${fx.alice.id}`), before, 'reading stays possible');
    // A key that merely looks similar is not affected.
    assert.equal(await fx.client.db.set('temp:todo_note', { ok: true }), true);
});

// ---- through the real interaction router -----------------------------------------

test('the interaction router delivers the buttons and forms of a shared list to their handlers', opts, async (t) => {
    const { fx, seedShared } = await setup(t);
    const { default: router } = await import('../src/events/interactionCreate.js');
    const { default: buttons } = await import('../src/interactions/buttons/todo/todoShared.js');
    const { default: modals } = await import('../src/interactions/modals/todo/todoShared.js');
    // The loaders register every handler under its name; the router looks it up there.
    Object.assign(fx.client, {
        buttons: new Map(buttons.map((handler) => [handler.name, handler])),
        modals: new Map(modals.map((handler) => [handler.name, handler])),
    });
    const kind = (which) => ({ isChatInputCommand: () => false, isAutocomplete: () => false, isButton: () => which === 'button', isStringSelectMenu: () => false, isModalSubmit: () => which === 'modal' });
    // A list id with a hyphen and digits: the router splits button ids on "_" and form ids on ":".
    const id = 'ab-12-cd';
    await fx.seedRow(`shared_todo_${id}`, { id, name: 'Trip', creatorId: fx.alice.id, members: [fx.alice.id], tasks: [task(1, 'pack')], nextId: 2, createdAt: at });
    await seedShared();

    for (const [name, title] of [['add', 'Add Task'], ['complete', 'Complete Task'], ['remove', 'Remove Task']]) {
        const press = fx.button(`shared_todo_${name}_${id}`);
        Object.assign(press.it, kind('button'));
        let shownModal = null;
        press.it.showModal = async (modal) => { shownModal = modal.toJSON(); };
        await router.execute(press.it, fx.client);
        assert.equal(shownModal?.custom_id, `shared_todo_${name}_modal:${id}`, name);
        assert.match(shownModal.title, new RegExp(title.split(' ')[0]));
    }

    const submit = async (name, fields) => {
        const form = fx.modal(`shared_todo_${name}_modal:${id}`, fields);
        Object.assign(form.it, kind('modal'));
        await router.execute(form.it, fx.client);
        return form;
    };
    assert.match((await submit('add', { task_text: 'book flight' })).said(), /Added #2 book flight/);
    assert.match((await submit('complete', { task_id: '1' })).said(), /#1 pack/);
    assert.match((await submit('remove', { task_id: '2' })).said(), /#2 book flight/);
    const stored = await fx.row(`shared_todo_${id}`);
    assert.deepEqual(stored.tasks.map((entry) => [entry.id, entry.text, entry.completed]), [[1, 'pack', true]]);
    // The other list was never touched by any of it.
    assert.deepEqual((await fx.row(KEY)).tasks, []);

    // An id the router cuts short ("a_b" becomes "a") finds no list and changes nothing.
    const cut = fx.button('shared_todo_add_a_b');
    Object.assign(cut.it, kind('button'));
    let opened = false;
    cut.it.showModal = async () => { opened = true; };
    await router.execute(cut.it, fx.client);
    assert.equal(opened, false);
    assert.match(cut.said(), /not found|no longer exists|not a valid/i);
});
