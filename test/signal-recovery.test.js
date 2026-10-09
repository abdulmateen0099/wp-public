import test from 'node:test';
import assert from 'node:assert/strict';
import { withSignalRecovery } from '../utils/signalRecovery.js';
import { DEFAULT_CONNECTION_CONFIG, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';

function setup() {
    const writes = [];
    let now = 100000;
    let failure = new Error('No matching sessions found for message');
    const repository = {
        jidToSignalProtocolAddress: jid => jid.replace('@s.whatsapp.net', '').replace(':', '.'),
        async decryptMessage() { if (failure) throw failure; return Buffer.from('decrypted command'); },
    };
    withSignalRecovery(repository, { set: async data => writes.push(data) }, {
        now: () => now, logger: { warn() {} },
    });
    return { repository, writes, advance: () => { now += 60001; }, succeed: () => { failure = null; }, fail: e => { failure = e; } };
}

test('repeated stale-session failures invalidate only the sender device and preserve retry errors', async () => {
    const h = setup(), input = { jid: '123:7@s.whatsapp.net', type: 'msg' };
    await assert.rejects(h.repository.decryptMessage(input), /No matching sessions/);
    assert.equal(h.writes.length, 0);
    await assert.rejects(h.repository.decryptMessage(input), /No matching sessions/);
    assert.deepEqual(h.writes, [{ session: { '123.7': null } }]);
    await assert.rejects(h.repository.decryptMessage(input));
    assert.equal(h.writes.length, 1);
    h.advance();
    await assert.rejects(h.repository.decryptMessage(input));
    assert.equal(h.writes.length, 2);
    h.succeed();
    assert.equal((await h.repository.decryptMessage(input)).toString(), 'decrypted command');
});

test('unrelated failures never reset sessions; successful decrypt clears the failure streak', async () => {
    const h = setup(), input = { jid: '123@s.whatsapp.net', type: 'msg' };
    h.fail(new Error('Bad MAC'));
    await assert.rejects(h.repository.decryptMessage(input));
    await assert.rejects(h.repository.decryptMessage(input));
    assert.equal(h.writes.length, 0);
    h.fail(new Error('No matching sessions found for message'));
    await assert.rejects(h.repository.decryptMessage(input));
    h.succeed();
    await h.repository.decryptMessage(input);
    h.fail(new Error('No matching sessions found for message'));
    await assert.rejects(h.repository.decryptMessage(input));
    assert.equal(h.writes.length, 0);
});

test('recovery invalidates the real Baileys key cache and persisted sender session', async () => {
    const persisted = { '123.7': { stale: true }, '456.0': { healthy: true } };
    const keys = makeCacheableSignalKeyStore({
        get: async (type, ids) => Object.fromEntries(ids.map(id => [id, persisted[id]])),
        set: async data => Object.assign(persisted, data.session),
    });
    await keys.get('session', ['123.7', '456.0']);
    const repository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository({ keys, creds: {} });
    repository.decryptMessage = async () => { throw new Error('No matching sessions found for message'); };
    withSignalRecovery(repository, keys);
    for (let i = 0; i < 2; i++) {
        await assert.rejects(repository.decryptMessage({ jid: '123:7@s.whatsapp.net', type: 'msg' }));
    }
    assert.equal(persisted['123.7'], null);
    assert.equal((await keys.get('session', ['123.7']))['123.7'], null);
    assert.deepEqual((await keys.get('session', ['456.0']))['456.0'], { healthy: true });
});

test('a storage failure preserves the original decrypt error for the retry receipt', async () => {
    const original = new Error('No matching sessions found for message');
    const repository = withSignalRecovery({
        decryptMessage: async () => { throw original; },
        jidToSignalProtocolAddress: () => '123.0',
    }, { set: async () => { throw new Error('Disk unavailable'); } });
    for (let i = 0; i < 2; i++) {
        await assert.rejects(repository.decryptMessage({ jid: '123@s.whatsapp.net' }), e => e === original);
    }
});
