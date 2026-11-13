import test from 'node:test';
import assert from 'node:assert/strict';
import { getLavalinkNodes } from '../src/config/music/lavalink.js';

const VARIABLES = ['LAVALINK_NODES', 'LAVALINK_NODES_FILE'];

/** Run `fn` with the given Lavalink variables, restoring the environment afterwards. */
function withEnv(values, fn) {
    const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
    try {
        for (const name of VARIABLES) {
            if (values[name] === undefined) delete process.env[name];
            else process.env[name] = values[name];
        }
        return fn();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

test('the shipped node list is the three public TLS nodes, in order', () => {
    const nodes = withEnv({}, getLavalinkNodes);
    assert.deepEqual(nodes, [
        { host: 'freelavalinkvinster.in', port: 443, password: 'youshallnotpass', secure: true, name: 'vinster' },
        { host: 'lavalink-v4.triniumhost.com', port: 443, password: 'free', secure: true, name: 'trinium' },
        { host: 'lavalink.nazha.online', port: 443, password: 'nazhafreelava', secure: true, name: 'nazha' },
    ]);
    // A host is a bare name: a scheme or port inside it would not connect.
    for (const node of nodes) assert.match(node.host, /^[a-z0-9.-]+$/);
    assert.equal(new Set(nodes.map((node) => node.name)).size, nodes.length);
});

test('LAVALINK_NODES still takes priority over the shipped list', () => {
    const own = [{ host: 'lavalink.example.test', port: 2333, password: 'x', secure: false, name: 'Own' }];
    assert.deepEqual(withEnv({ LAVALINK_NODES: JSON.stringify(own) }, getLavalinkNodes), own);
    // Unreadable JSON falls back to the shipped list instead of leaving music without nodes.
    assert.equal(withEnv({ LAVALINK_NODES: '{not json' }, getLavalinkNodes).length, 3);
});
