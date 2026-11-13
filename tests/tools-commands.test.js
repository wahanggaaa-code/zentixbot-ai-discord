import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { Collection } from 'discord.js';
import { getCommandAccessSnapshot, isCommandEnabledInConfig, isProtectedCommand } from '../src/services/commandAccessService.js';
import axios from 'axios';
import { createToolsFixture, memberId } from './helpers/tools-fixture.js';
import { logger } from '../src/utils/logger.js';
import { LookupFailure, getText } from '../src/services/searchLookup.js';
import shorten, { readShortenerAnswer, shortenableUrl } from '../src/commands/Tools/shorten.js';
import hexcolor, { nearestNamedColor, parseHexColor, rgbToHsl } from '../src/commands/Tools/hexcolor.js';
import baseconvert, { MAX_INPUT_LENGTH, formatInBase, parseInBase } from '../src/commands/Tools/baseconvert.js';
import generatepassword, { generatePassword } from '../src/commands/Tools/generatepassword.js';
import randomuser, { candidates, drawPayload } from '../src/commands/Tools/randomuser.js';
import randomUserButtons from '../src/interactions/buttons/randomuser/randomuser.js';
import time, { resolveTimeZone } from '../src/commands/Tools/time.js';
import unixtime from '../src/commands/Tools/unixtime.js';

// ---- shorten --------------------------------------------------------------------------------

/** Replaces axios.get for one test. `answer(url)` returns `{ status, data }` or an Error to throw. */
function shortener(t, answer) {
    const urls = [];
    t.mock.method(axios, 'get', async (url) => {
        urls.push(url);
        const result = typeof answer === 'function' ? answer(url) : answer;
        if (result instanceof Error) throw result;
        return { status: 200, ...result };
    });
    t.mock.method(logger, 'warn', () => {});
    return urls;
}

test('only web addresses are sent to the shortener', async (t) => {
    const urls = shortener(t, { data: 'https://is.gd/abc123' });
    const fx = createToolsFixture();
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi', 'example.com', 'https://user:pass@example.com/', 'https://', '   ', `https://example.com/${'a'.repeat(2000)}`]) {
        const out = await fx.run(shorten, fx.slash(fx.alice, { url }));
        assert.match(out.said(), /starts with http:\/\/ or https:\/\//, url);
    }
    assert.equal(urls.length, 0, 'nothing was requested');
    assert.equal(shortenableUrl('HTTP://Example.com/a b')?.href, 'http://example.com/a%20b');
    assert.equal(shortenableUrl(null), null);
});

test('a link is reported only when the service answers with exactly one is.gd link', async (t) => {
    const urls = shortener(t, { data: 'https://is.gd/abc123\n' });
    const fx = createToolsFixture();
    const out = await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/a?b=1&c=2', custom: 'my_link' }));
    assert.equal(out.embed().title, 'URL Shortened');
    assert.match(out.embed().description, /^Short link: https:\/\/is\.gd\/abc123\nPoints to: `https:\/\/example\.com\/a\?b=1&c=2`$/);
    assert.equal(out.isPrivate(), true);
    assert.equal(urls[0], 'https://is.gd/create.php?format=simple&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&shorturl=my_link');

    assert.deepEqual(readShortenerAnswer('https://is.gd/abc123'), { link: 'https://is.gd/abc123' });
    for (const answer of ['https://is.gd/abc123\nhttps://evil.example', 'http://is.gd/abc123', 'https://is.gd.evil.example/abc', 'https://is.gd/abc 123', 'see https://is.gd/abc123', '<html>busy</html>', '', null]) {
        assert.equal(readShortenerAnswer(answer).link, undefined, String(answer));
    }
});

test('a refusal from the shortener is shown as a refusal, as inert text', async (t) => {
    shortener(t, { status: 400, data: 'Error: **x** [click](https://evil.example) @everyone `tick`' });
    const fx = createToolsFixture();
    const out = await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/' }));
    assert.notEqual(out.embed().title, 'URL Shortened');
    assert.match(out.said(), /The shortener refused this address: `\*\*x\*\* \[click\]\(https:\/\/evil\.example\) @everyone 'tick'`/);
    assert.doesNotMatch(out.said(), /Short link/);
});

test('a taken custom ending, a bad custom ending and an unreadable answer each get their own message', async (t) => {
    const fx = createToolsFixture();
    let urls = shortener(t, { status: 406, data: 'Error: The shortened URL you picked already exists, please choose another.' });
    assert.match((await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/', custom: 'taken_1' }))).said(), /custom ending is already taken/);
    assert.equal(urls.length, 1);

    for (const custom of ['abc', 'has space', 'x'.repeat(31), 'bad-dash', 'ünïcode']) {
        assert.match((await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/', custom }))).said(), /5 to 30 characters/, custom);
    }
    assert.equal(urls.length, 1);

    t.mock.restoreAll();
    urls = shortener(t, { data: '<html>maintenance</html>\nhttps://evil.example' });
    const garbage = await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/' }));
    assert.match(garbage.said(), /URL shortener \(is\.gd\)/);
    assert.doesNotMatch(garbage.said(), /evil\.example|maintenance|URL Shortened/);

    t.mock.restoreAll();
    shortener(t, Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
    const down = await fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/' }));
    assert.match(down.said(), /URL shortener \(is\.gd\)/);
    assert.doesNotMatch(down.said(), /URL Shortened|ECONNABORTED/);
});

test('a fault that is not a lookup failure is not dressed up as one', async (t) => {
    t.mock.method(axios, 'get', async () => ({ status: 200, get data() { throw new TypeError('boom'); } }));
    const fx = createToolsFixture();
    await assert.rejects(fx.run(shorten, fx.slash(fx.alice, { url: 'https://example.com/' })), /boom/);
});

test('getText reads short plain answers of any status and refuses large ones without reading them', async (t) => {
    let sent = 0;
    const server = http.createServer((request, response) => {
        if (request.url === '/ok') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('{"looks":"like json"}'); return; }
        if (request.url === '/refused') { response.writeHead(400); response.end('Error: no'); return; }
        if (request.url === '/slow-down') { response.writeHead(429); response.end('later'); return; }
        if (request.url === '/moved') { response.writeHead(302, { Location: '/ok' }); response.end(); return; }
        // An endless answer without a declared length.
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        const chunk = 'x'.repeat(16 * 1024);
        const timer = setInterval(() => { sent += chunk.length; response.write(chunk); }, 1);
        response.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;

    assert.deepEqual(await getText(`${base}/ok`), { status: 200, text: '{"looks":"like json"}' });
    assert.deepEqual(await getText(`${base}/refused`), { status: 400, text: 'Error: no' });
    assert.equal((await getText(`${base}/moved`)).status, 302, 'redirects are not followed');
    await assert.rejects(getText(`${base}/slow-down`), (error) => error.kind === LookupFailure.RATE_LIMITED);
    await assert.rejects(getText(`${base}/endless`), (error) => error.kind === LookupFailure.BAD_RESPONSE);
    assert.ok(sent < 1024 * 1024, `stopped after ${sent} bytes`);
    await assert.rejects(getText('http://127.0.0.1:1/'), (error) => error.kind === LookupFailure.UNREACHABLE);
});

// ---- hexcolor -------------------------------------------------------------------------------

test('hex colors: three or six digits, with or without #', async () => {
    assert.equal(parseHexColor('#ff5733'), '#FF5733');
    assert.equal(parseHexColor('FF5733'), '#FF5733');
    assert.equal(parseHexColor(' f53 '), '#FF5533');
    for (const bad of ['#ABCD', 'ABCDE', 'GGGGGG', '#FF57333', '', '##FFF', 'FF 57 33', null]) assert.equal(parseHexColor(bad), null, String(bad));

    const fx = createToolsFixture();
    for (const color of ['#ABCD', 'ABCDE', 'zzz']) {
        const out = await fx.run(hexcolor, fx.slash(fx.alice, { color }));
        assert.match(out.said(), /hex color of 3 or 6 digits/, color);
        assert.doesNotMatch(out.said(), /Something Went Wrong|Failed to generate/);
    }
});

test('color details: HSL of dark colors and the nearest name', async () => {
    assert.equal(rgbToHsl(1, 0, 0), 'hsl(0, 100%, 0%)');
    assert.equal(rgbToHsl(255, 0, 0), 'hsl(0, 100%, 50%)');
    assert.equal(rgbToHsl(128, 128, 128), 'hsl(0, 0%, 50%)');
    assert.equal(rgbToHsl(0, 0, 255), 'hsl(240, 100%, 50%)');
    assert.deepEqual(nearestNamedColor('#010000'), { name: 'Black', exact: false });
    assert.deepEqual(nearestNamedColor('#FF0000'), { name: 'Red', exact: true });
    assert.deepEqual(nearestNamedColor('#FE0101'), { name: 'Red', exact: false });
    assert.deepEqual(nearestNamedColor('#00FEFE'), { name: 'Cyan', exact: false });

    const fx = createToolsFixture();
    const dark = await fx.run(hexcolor, fx.slash(fx.alice, { color: '#010000' }));
    assert.match(dark.said(), /\*\*Hex:\*\* `#010000`/);
    assert.match(dark.said(), /\*\*RGB:\*\* `rgb\(1, 0, 0\)`/);
    assert.match(dark.said(), /\*\*Nearest named color:\*\* Black/);
    assert.equal(dark.embed().color, 0x010000);
    assert.equal(dark.embed().image.url, 'https://dummyimage.com/200x100/010000/FFFFFF?text=%23010000');
    assert.equal(dark.isPrivate(), true);
    const red = await fx.run(hexcolor, fx.slash(fx.alice, { color: 'f00' }));
    assert.match(red.said(), /\*\*Name:\*\* Red/);
    assert.doesNotMatch(red.said(), /Randomly generated/);
    const white = await fx.run(hexcolor, fx.slash(fx.alice, { color: 'FFFFFF' }));
    assert.equal(white.embed().image.url, 'https://dummyimage.com/200x100/FFFFFF/000000?text=%23FFFFFF');
});

test('a random color is a full six-digit color in capitals', async () => {
    const fx = createToolsFixture();
    for (let n = 0; n < 20; n++) {
        const out = await fx.run(hexcolor, fx.slash(fx.alice, {}));
        assert.match(out.embed().description, /^\*\*Hex:\*\* `#[0-9A-F]{6}`\n/);
        assert.match(out.embed().description, /\n\nRandomly generated color\.$/);
    }
});

// ---- baseconvert ----------------------------------------------------------------------------

test('bases: case matters where the alphabet has both cases', () => {
    assert.equal(parseInBase('ff', 'HEX'), 255n);
    assert.equal(parseInBase('FF', 'HEX'), 255n);
    assert.equal(parseInBase('zz', 'B36'), 1295n);
    assert.equal(parseInBase('1010', 'BIN'), 10n);
    assert.equal(parseInBase('a', 'B62'), 36n);
    assert.equal(parseInBase('A', 'B62'), 10n);
    assert.equal(parseInBase('a', 'B58'), 33n);
    assert.equal(parseInBase('A', 'B58'), 9n);
    // Base58 has no 0, O, I or l.
    for (const bad of ['lO', '0', 'O', 'I', 'l']) assert.equal(parseInBase(bad, 'B58'), null, bad);
    for (const [text, base] of [['2', 'BIN'], ['8', 'OCT'], ['1.5', 'DEC'], ['-1', 'DEC'], ['G', 'HEX'], ['1 0', 'BIN'], ['', 'DEC'], ['1', 'B99']]) assert.equal(parseInBase(text, base), null, `${text} ${base}`);
});

test('bases: Base64 is read strictly and every base round-trips', () => {
    assert.equal(parseInBase('AQ==', 'B64'), 1n);
    assert.equal(parseInBase('/w==', 'B64'), 255n);
    assert.equal(parseInBase('AQAB', 'B64'), 65537n);
    for (const bad of ['a=b', 'AQ=', 'AQ', 'A===', 'AQ==AQ==', 'AR==', '-_-_', 'AQ ==']) assert.equal(parseInBase(bad, 'B64'), null, bad);
    assert.equal(formatInBase(0n, 'B64'), 'AA==');
    assert.equal(formatInBase(0n, 'B58'), '1');
    assert.equal(formatInBase(0n, 'HEX'), '0');
    const big = 2n ** 521n - 1n;
    for (const base of ['BIN', 'OCT', 'DEC', 'HEX', 'B64', 'B36', 'B58', 'B62']) {
        for (const value of [0n, 1n, 57n, 58n, 255n, 65536n, big]) assert.equal(parseInBase(formatInBase(value, base), base), value, `${base} ${value}`);
    }
});

test('/baseconvert converts exactly and explains what it refuses', async () => {
    const fx = createToolsFixture();
    const ask = async (number, from, to = null) => fx.run(baseconvert, fx.slash(fx.alice, { number, from, to }));

    const one = await ask('0xff', 'HEX', 'BIN');
    assert.equal(one.embed().title, 'Base Conversion Result');
    assert.equal(one.embed().description, '**Input (Hexadecimal):** `0xFF`\n**Binary (BIN):** `0b11111111`\n**Decimal:** `255`');
    assert.equal((await ask('0XFF', 'HEX', 'DEC')).embed().description, '**Input (Hexadecimal):** `0xFF`\n**Decimal (DEC):** `255`');

    const all = await ask('255', 'DEC');
    assert.equal(all.embed().title, 'Base Conversion Results');
    assert.equal(all.embed().description.split('\n').length, 8);
    assert.match(all.embed().description, /\*\*Base58 \(B58\):\*\* `5Q`/);
    assert.match(all.embed().description, /\*\*Base64 \(B64\):\*\* `b64:\/w==`/);

    assert.equal((await ask('123456789012345678901234567890', 'DEC', 'HEX')).embed().description.split('\n')[1], '**Hexadecimal (HEX):** `0x18EE90FF6C373E0EE4E3F0AD2`');

    const refused = await ask('lO', 'B58', 'DEC');
    assert.match(refused.said(), /`lO` is not a Base58 number/);
    assert.match(refused.said(), /without 0, O, I and l/);
    assert.doesNotMatch(refused.said(), /too large/);
    assert.match((await ask('a=b', 'B64', 'DEC')).said(), /is not a Base64 number/);
    assert.match((await ask('0x', 'HEX')).said(), /give a number to convert/);
    assert.match((await ask('   ', 'DEC')).said(), /give a number to convert/);
    assert.match((await ask('12', 'ROMAN')).said(), /choose the bases from the list/);
    assert.match((await ask('12', 'DEC', 'ROMAN')).said(), /choose the bases from the list/);
});

test('/baseconvert: the longest accepted number still fits in one answer, whole', async () => {
    const fx = createToolsFixture();
    const longest = 'z'.repeat(MAX_INPUT_LENGTH);
    const out = await fx.run(baseconvert, fx.slash(fx.alice, { number: longest, from: 'B62' }));
    const { description } = out.embed();
    assert.ok(description.length <= 4096, `${description.length}`);
    const lines = description.split('\n');
    assert.equal(lines.length, 8);
    for (const line of lines) assert.match(line, /^\*\*[^`]+\*\* `[^`]+`$/, 'no line is cut in the middle');
    const binary = /`0b([01]+)`/.exec(description)[1];
    assert.equal(parseInBase(binary, 'BIN'), parseInBase(longest, 'B62'));

    const tooLong = await fx.run(baseconvert, fx.slash(fx.alice, { number: '1'.repeat(MAX_INPUT_LENGTH + 1), from: 'DEC' }));
    assert.match(tooLong.said(), /too long/);
    assert.doesNotMatch(tooLong.said(), /Base Conversion/);
});

// ---- generatepassword -----------------------------------------------------------------------

const CLASS = { lowercase: /[a-z]/, uppercase: /[A-Z]/, numbers: /[0-9]/, symbols: /[^A-Za-z0-9]/ };

test('a password has every requested kind of character, whatever the random source gives', () => {
    const all = ['lowercase', 'uppercase', 'numbers', 'symbols'];
    for (const pick of [() => 0, (n) => n - 1, (n) => Math.floor(n / 2)]) {
        for (const length of [8, 16, 50]) {
            const { password } = generatePassword(length, all, pick);
            assert.equal(password.length, length);
            for (const name of all) assert.match(password, CLASS[name], `${name} in ${password}`);
        }
    }
    for (let n = 0; n < 300; n++) {
        const wanted = all.filter((name, index) => index === 0 || (n >> index) & 1);
        const { password, bits } = generatePassword(8, wanted);
        assert.equal(password.length, 8);
        assert.match(password, /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]+$/);
        for (const name of all) assert.equal(CLASS[name].test(password), wanted.includes(name) ? true : false, `${name} in ${password} (${wanted})`);
        assert.ok(bits >= 37);
    }
});

test('/generatepassword answers privately and says what the password contains', async () => {
    const fx = createToolsFixture();
    const out = await fx.run(generatepassword, fx.slash(fx.alice, { length: 12, symbols: false }));
    assert.equal(out.isPrivate(), true);
    const password = /\|\|`([^`]+)`\|\|/.exec(out.embed().description)[1];
    assert.equal(password.length, 12);
    assert.match(password, /^[A-Za-z0-9]+$/);
    assert.match(out.embed().description, /\*\*Contains:\*\* Lowercase, Uppercase, Numbers\n/);
    assert.match(out.embed().description, /about 71 bits\n\nOnly you can see this message\. The password is not stored or logged\.$/);
    assert.equal(/\|\|`([^`]+)`\|\|/.exec((await fx.run(generatepassword, fx.slash(fx.alice, {}))).embed().description)[1].length, 16);
    for (const length of [7, 51, 8.5]) assert.match((await fx.run(generatepassword, fx.slash(fx.alice, { length }))).said(), /from 8 to 50/);
});

// ---- randomuser -----------------------------------------------------------------------------

function crowd() {
    const fx = createToolsFixture();
    fx.register('buttons', randomUserButtons);
    const staff = fx.addRole('500000000000000001', 'Staff', 5);
    const helper = fx.addRole('500000000000000002', 'Helper', 3);
    const empty = fx.addRole('500000000000000003', 'Empty', 1);
    const carol = fx.addMember(memberId(3), { name: 'carol **bold**', roles: [staff, helper] });
    const robot = fx.addMember(memberId(50), { bot: true, name: 'robot', roles: [staff] });
    return { fx, staff, helper, empty, carol, robot };
}

test('/randomuser answers (it used to fail on every call) and leaves bots out unless asked', async () => {
    const { fx, staff, carol, robot } = crowd();
    const out = await fx.run(randomuser, fx.slash(fx.alice, {}));
    assert.equal(out.embed().title, 'Random User Selected');
    assert.equal(typeof out.embed().color, 'number');
    assert.match(out.embed().description, /\n\nDrawn from 4 matching member\(s\)\.$/);
    assert.deepEqual(out.buttonIds(), [`randomuser:again:${fx.alice.id}:0:0`]);

    assert.deepEqual(candidates(fx.guild).map((m) => m.id).sort(), [fx.alice.id, fx.bob.id, carol.id, fx.moderator.id].sort());
    assert.equal(candidates(fx.guild, { includeBots: true }).length, 6);
    assert.deepEqual(candidates(fx.guild, { roleId: staff.id }).map((m) => m.id), [carol.id]);
    assert.deepEqual(candidates(fx.guild, { roleId: staff.id, includeBots: true }).map((m) => m.id).sort(), [carol.id, robot.id].sort());
});

test('/randomuser: role filter, names as plain text, and a ping only when asked for', async () => {
    const { fx, staff, helper, empty, carol } = crowd();
    const quiet = await fx.run(randomuser, fx.slash(fx.alice, { role: staff }));
    assert.equal(quiet.embed().description, '**carol \\*\\*bold\\*\\***\n\nDrawn from 1 matching member(s).');
    assert.equal(quiet.replies.at(-1).content, null);
    assert.deepEqual(quiet.replies.at(-1).allowedMentions, { parse: [], users: [] });
    assert.match(quiet.said(), new RegExp(`Roles \\(2\\): <@&${staff.id}> <@&${helper.id}>`));
    assert.deepEqual(quiet.buttonIds(), [`randomuser:again:${fx.alice.id}:${staff.id}:0`]);

    const loud = await fx.run(randomuser, fx.slash(fx.alice, { role: staff, mention: true }));
    assert.equal(loud.replies.at(-1).content, `<@${carol.id}>, you've been chosen!`);
    assert.deepEqual(loud.replies.at(-1).allowedMentions, { parse: [], users: [carol.id] });
    assert.deepEqual(loud.buttonIds(), [`randomuser:again:${fx.alice.id}:${staff.id}:2`]);

    const nobody = await fx.run(randomuser, fx.slash(fx.alice, { role: empty }));
    assert.match(nobody.said(), new RegExp(`Nobody I know of has the role <@&${empty.id}>`));
    assert.equal(nobody.buttonIds().length, 0);
});

test('/randomuser says when it only knows part of the server', async () => {
    const { fx } = crowd();
    fx.guild.memberCount = 5000;
    const out = await fx.run(randomuser, fx.slash(fx.alice, {}));
    assert.match(out.embed().description, /\n\nDrawn from 4 matching of the 6 members I currently know of \(the server has 5000\)\.$/);
    assert.equal(randomuser.data.toJSON().options.some((o) => o.name === 'online'), false, 'the bot receives no presence data');
});

test('"Pick Another User" keeps the filters, belongs to the member who asked, and refuses forged ids', async () => {
    const { fx, staff, carol, robot } = crowd();
    const first = await fx.run(randomuser, fx.slash(fx.alice, { role: staff, bots: true }));
    const [id] = first.buttonIds();
    assert.equal(id, `randomuser:again:${fx.alice.id}:${staff.id}:1`);

    const seen = new Set();
    for (let n = 0; n < 40; n++) {
        const again = await fx.route(fx.button(fx.alice, id, { message: first.message }));
        assert.equal(again.replies.at(-1).method, 'update');
        assert.deepEqual(again.buttonIds(), [id]);
        seen.add(/\*\*(.+)\*\*/.exec(again.embed().description)[1]);
    }
    assert.deepEqual([...seen].sort(), ['carol \\*\\*bold\\*\\*', 'robot']);
    assert.equal(drawPayload(fx.guild, fx.alice.id, { roleId: staff.id, includeBots: true }, () => 1).embeds[0].toJSON().fields[1].value, [carol, robot][1].user.bot ? 'Yes' : 'No');

    const other = await fx.route(fx.button(fx.bob, id, { message: first.message }));
    assert.match(other.said(), /Only the member who ran this command can pick again/);
    assert.equal(other.isPrivate(), true);

    for (const forged of [`randomuser:again:${fx.alice.id}:0:9`, `randomuser:again:${fx.alice.id}:abc:0`, `randomuser:again:someone:0:0`, `randomuser:other:${fx.alice.id}:0:0`, `randomuser:again:${fx.alice.id}`]) {
        const out = await fx.route(fx.button(fx.alice, forged, { message: first.message }));
        assert.match(out.said(), /no longer valid/, forged);
    }
    const gone = await fx.route(fx.button(fx.alice, `randomuser:again:${fx.alice.id}:500000000000000009:0`, { message: first.message }));
    assert.match(gone.said(), /could not find any member matching/);
});

// ---- time, unixtime -------------------------------------------------------------------------

test('time zones are named the way the runtime names them', async (t) => {
    assert.equal(resolveTimeZone('asia/jakarta'), 'Asia/Jakarta');
    assert.equal(resolveTimeZone(' Europe/London '), 'Europe/London');
    assert.equal(resolveTimeZone('utc'), 'UTC');
    for (const bad of ['WIB', 'Mars/Phobos', '', 'x'.repeat(65), null]) assert.equal(resolveTimeZone(bad), null, String(bad));

    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12, 0, 0) });
    const fx = createToolsFixture();
    const out = await fx.run(time, fx.slash(fx.alice, { timezone: 'asia/jakarta' }));
    assert.match(out.embed().description, /^\*\*Asia\/Jakarta:\*\* Thursday, January 1, 2026 at 07:00:00 PM GMT\+7\n/);
    assert.match(out.embed().description, /\*\*Your own time:\*\* <t:1767268800:F>/);
    assert.match(out.embed().description, /\*\*Unix Timestamp:\*\* `1767268800`/);
    assert.equal(out.isPrivate(), true);
    assert.match((await fx.run(time, fx.slash(fx.alice, {}))).embed().description, /^\*\*UTC:\*\* Thursday, January 1, 2026 at 12:00:00 PM UTC\n/);

    const refused = await fx.run(time, fx.slash(fx.alice, { timezone: 'WIB' }));
    assert.match(refused.said(), /I do not know that timezone/);
    assert.match(refused.said(), /Abbreviations such as WIB or PST are not timezone names/);
});

test('/unixtime shows the same moment in every form', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12, 0, 0) + 123 });
    const fx = createToolsFixture();
    const out = await fx.run(unixtime, fx.slash(fx.alice, {}));
    assert.equal(out.embed().description, [
        '**Seconds since Unix Epoch:** `1767268800`',
        '**Milliseconds since Unix Epoch:** `1767268800123`',
        '',
        '**Human-readable (UTC):** Thu, 01 Jan 2026 12:00:00 GMT',
        '**Your own time:** <t:1767268800:F>',
        '**ISO String:** `2026-01-01T12:00:00.123Z`',
        '**As a Discord timestamp:** `<t:1767268800:F>`',
    ].join('\n'));
    assert.equal(out.isPrivate(), true);
});

// ---- the category as a whole ----------------------------------------------------------------

test('every Tools command can be switched off per server, and the dashboard names exactly these commands', async () => {
    const files = readdirSync(new URL('../src/commands/Tools/', import.meta.url)).filter((name) => name.endsWith('.js'));
    const commands = new Collection();
    for (const file of files) {
        const command = (await import(`../src/commands/Tools/${file}`)).default;
        // What the command loader does with the folder name.
        command.category = 'Tools';
        commands.set(command.data.name, command);
    }
    const names = [...commands.keys()].sort();
    assert.equal(names.length, 11);

    const config = { disabledCommands: { poll: true } };
    for (const name of names) {
        assert.equal(isProtectedCommand(name), false, name);
        assert.equal(isCommandEnabledInConfig(config, name, 'Tools'), name !== 'poll', name);
        assert.equal(isCommandEnabledInConfig({ disabledCategories: { tools: true } }, name, 'Tools'), false, name);
    }
    const snapshot = JSON.stringify(getCommandAccessSnapshot({ commands }, config));
    for (const name of names) assert.ok(snapshot.includes(`"${name}"`), `${name} is listed on the command access page`);

    const page = readFileSync(new URL('../dashboard-preview/features.js', import.meta.url), 'utf8');
    const listed = /\{name:'Tools',commands:\[([^\]]+)\]/.exec(page)[1].split(',').map((entry) => entry.replace(/['/]/g, ''));
    assert.deepEqual(listed, names);
});
