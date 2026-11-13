import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
    getJson, LookupError, LookupFailure, lookupFailureMessage, plainText, codeSpan, encodeQuery,
    LOOKUP_TIMEOUT_MS, LOOKUP_DEADLINE_MS, LOOKUP_MAX_BYTES,
} from '../src/services/searchLookup.js';

/** A real HTTP server on 127.0.0.1; `routes` maps a path to a request handler. */
async function serve(t, routes) {
    const sockets = new Set();
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        const handler = routes[req.url.split('?')[0]];
        if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"title":"No Definitions Found"}'); return; }
        handler(req, res);
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    return { base: `http://127.0.0.1:${server.address().port}`, hits };
}
const sendJson = (body, status = 200) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const failure = async (promise) => {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error instanceof LookupError, `expected a LookupError, got ${error}`);
    return error;
};

test('lookup: a JSON answer is returned as data; the limits are the documented ones', async (t) => {
    const { base } = await serve(t, { '/list': sendJson([{ word: 'set' }]), '/object': sendJson({ list: [] }) });
    assert.deepEqual(await getJson(`${base}/list`), [{ word: 'set' }]);
    assert.deepEqual(await getJson(`${base}/object`), { list: [] });
    assert.deepEqual([LOOKUP_TIMEOUT_MS, LOOKUP_DEADLINE_MS, LOOKUP_MAX_BYTES], [5000, 8000, 524288]);
});

test('lookup: each kind of failure is told apart', async (t) => {
    const { base } = await serve(t, {
        '/limited': sendJson({ message: 'slow down' }, 429),
        '/broken': sendJson({ message: 'oops' }, 500),
        '/html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); },
        '/text-as-json': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('"just a string"'); },
        '/null': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); },
        '/empty': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(''); },
    });
    const missing = await failure(getJson(`${base}/nothing-here`));
    assert.deepEqual([missing.kind, missing.status], [LookupFailure.NOT_FOUND, 404]);
    const limited = await failure(getJson(`${base}/limited`));
    assert.deepEqual([limited.kind, limited.status], [LookupFailure.RATE_LIMITED, 429]);
    const broken = await failure(getJson(`${base}/broken`));
    assert.deepEqual([broken.kind, broken.status], [LookupFailure.BAD_RESPONSE, 500]);
    for (const path of ['/html', '/text-as-json', '/null', '/empty']) {
        const error = await failure(getJson(`${base}${path}`));
        assert.equal(error.kind, LookupFailure.BAD_RESPONSE, path);
    }
});

// The test has its own time limit: without the limits it checks, the request below would never end.
test('lookup: a server that is down, silent, or endlessly slow ends as "unreachable" within the time allowed', { timeout: 15_000 }, async (t) => {
    const { base } = await serve(t, {
        '/silent': () => { /* never answers */ },
        '/trickle': (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('[');
            const timer = setInterval(() => res.write(' '), 40);
            res.on('close', () => clearInterval(timer));
        },
    });
    let started = Date.now();
    const silent = await failure(getJson(`${base}/silent`, { timeoutMs: 200, deadlineMs: 5000 }));
    assert.equal(silent.kind, LookupFailure.UNREACHABLE);
    assert.ok(Date.now() - started < 2000, 'the idle timeout ended it');

    // Data keeps arriving, so the idle timeout never fires; the deadline for the whole request does.
    started = Date.now();
    const trickle = await failure(getJson(`${base}/trickle`, { timeoutMs: 300, deadlineMs: 700 }));
    assert.equal(trickle.kind, LookupFailure.UNREACHABLE);
    const took = Date.now() - started;
    assert.ok(took >= 600 && took < 3000, `ended by the deadline, after ${took} ms`);

    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    const refused = await failure(getJson(`http://127.0.0.1:${port}/x`));
    assert.equal(refused.kind, LookupFailure.UNREACHABLE);
    assert.equal(refused.reason, 'ECONNREFUSED');
});

test('lookup: an answer larger than the limit is not read; a redirect loop is not followed forever', async (t) => {
    let hops = 0;
    const { base, hits } = await serve(t, {
        '/huge': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ blob: 'x'.repeat(4000) })); },
        '/small': sendJson({ blob: 'x'.repeat(100) }),
        '/loop': (req, res) => { hops += 1; res.writeHead(302, { location: '/loop' }); res.end(); },
        '/once': (req, res) => { res.writeHead(302, { location: '/small' }); res.end(); },
    });
    const huge = await failure(getJson(`${base}/huge`, { maxBytes: 1000 }));
    assert.equal(huge.kind, LookupFailure.BAD_RESPONSE);
    assert.equal((await getJson(`${base}/small`, { maxBytes: 1000 })).blob.length, 100);

    const loop = await failure(getJson(`${base}/loop`));
    assert.notEqual(loop.kind, LookupFailure.NOT_FOUND);
    assert.equal(hops, 3, 'the first request and two redirects, then it stops');
    assert.equal((await getJson(`${base}/once`)).blob.length, 100, 'one redirect is followed');
    assert.equal(hits.at(-1), '/small');
});

test('lookup: the message names the service and matches the failure', () => {
    const of = (kind) => lookupFailureMessage(new LookupError(kind), 'Urban Dictionary');
    assert.equal(of(LookupFailure.RATE_LIMITED), 'Urban Dictionary is receiving too many requests. Please try again in a few minutes.');
    assert.equal(of(LookupFailure.UNREACHABLE), 'Urban Dictionary could not be reached. Please try again later.');
    assert.equal(of(LookupFailure.BAD_RESPONSE), 'Urban Dictionary did not give a usable answer. Please try again later.');
    assert.equal(lookupFailureMessage(null, 'The dictionary service'), 'The dictionary service did not give a usable answer. Please try again later.');
});

test('text from outside: markdown and masked links are escaped, and the limit holds', () => {
    assert.equal(plainText('[free nitro](https://evil.example)', 100), '\\[free nitro](https://evil.example)');
    assert.equal(plainText('**bold** _i_ ~~s~~ ||sp|| `c`', 100), '\\*\\*bold\\*\\* \\_i\\_ \\~\\~s\\~\\~ \\|\\|sp\\|\\| \\`c\\`');
    assert.equal(plainText('line\n# heading', 100), 'line\n\\# heading');
    assert.equal(plainText('  a\u0000b\tc  ', 100), 'a b c');
    for (const value of [undefined, null, 12, {}, ['x']]) assert.equal(plainText(value, 100), '');

    // Never longer than the limit, never ending in half an escape or half an emoji.
    for (const [value, limit] of [['a\\'.repeat(40), 9], ['*'.repeat(50), 10], ['*'.repeat(50), 11], ['😀'.repeat(20), 6], ['😀'.repeat(20), 7], ['plain words '.repeat(30), 50]]) {
        const out = plainText(value, limit);
        assert.ok(out.length <= limit, `${JSON.stringify(out)} fits ${limit}`);
        assert.ok(out.endsWith('…'));
        const body = out.slice(0, -1);
        assert.equal((/\\+$/.exec(body)?.[0].length ?? 0) % 2, 0, `${JSON.stringify(out)} does not end in a lone backslash`);
        assert.doesNotMatch(body, /[\uD800-\uDBFF]$/, 'no half surrogate pair');
    }
    assert.equal(plainText('short', 5), 'short');
});

test('a member\'s input is echoed inside a code span that it cannot close', () => {
    assert.equal(codeSpan('hello'), '`hello`');
    assert.equal(codeSpan('x](https://evil.example) [y'), '`x](https://evil.example) [y`');
    assert.equal(codeSpan('a`b```c'), "`a'b'''c`");
    assert.equal(codeSpan('two\nlines\tand   spaces'), '`two lines and spaces`');
    assert.equal(codeSpan(''), '` `');
    assert.equal(codeSpan(null), '` `');
    assert.equal(codeSpan('a'.repeat(300)), `\`${'a'.repeat(99)}…\``);
    assert.equal(codeSpan('a'.repeat(300), 10), `\`${'a'.repeat(9)}…\``);
    for (const value of ['`', '``', '`x`', 'a`'.repeat(60)]) assert.equal((codeSpan(value).match(/`/g) ?? []).length, 2, value);
});

test('a query in a URL: every character that could end a markdown link is encoded', () => {
    assert.equal(encodeQuery("f(x) = 2!'*"), 'f%28x%29%20%3D%202%21%27%2A');
    assert.equal(encodeQuery('x](https://evil.example) [y'), 'x%5D%28https%3A%2F%2Fevil.example%29%20%5By');
    assert.equal(encodeQuery('kopi & teh #1'), 'kopi%20%26%20teh%20%231');
    assert.equal(decodeURIComponent(encodeQuery('çay (чай) 茶')), 'çay (чай) 茶');
    assert.doesNotMatch(encodeQuery(' ()[]<>"\'`\n'), /[\s()[\]<>"'`]/);
});
