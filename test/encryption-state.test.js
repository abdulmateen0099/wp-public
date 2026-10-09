import test from 'node:test';
import assert from 'node:assert/strict';
import { addTransactionCapability, DEFAULT_CONNECTION_CONFIG, initAuthCreds, generateSignalPubKey, BufferJSON } from '@whiskeysockets/baileys';

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

test('overlapping Signal transactions retain the newest ratchet after a slow disk commit', async () => {
    let stored = 0, commits = 0, releaseCommit, commitStarted;
    const started = new Promise(resolve => { commitStarted = resolve; });
    const gate = new Promise(resolve => { releaseCommit = resolve; });
    const keys = addTransactionCapability({
        get: async () => ({ phone: stored }),
        set: async data => {
            const snapshot = data.session.phone;
            if (++commits === 1) { commitStarted(); await gate; }
            stored = snapshot;
        },
    }, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
    const first = keys.transaction(async () => {
        await keys.set({ session: { phone: 1 } });
    }, 'phone');
    await started;
    const second = keys.transaction(async () => {
        await keys.set({ session: { phone: 2 } });
    }, 'phone');
    // Allow the second transaction to run if the implementation fails to queue it.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    releaseCommit();
    await Promise.all([first, second]);
    assert.equal(stored, 2, 'the second send must not reuse the first send\'s ratchet');
    assert.equal((await keys.get('session', ['phone'])).phone, 2);
});

function endpoint() {
    const creds = initAuthCreds();
    const disk = {};
    const clone = value => JSON.parse(JSON.stringify(value, BufferJSON.replacer), BufferJSON.reviver);
    const reload = () => {
        const keys = addTransactionCapability({
            get: async (type, ids) => Object.fromEntries(ids.map(id => [id, disk[type]?.[id] ? clone(disk[type][id]) : null])),
            set: async data => {
                await new Promise(resolve => setImmediate(resolve));
                for (const [type, entries] of Object.entries(data)) {
                    disk[type] ||= {};
                    for (const [id, value] of Object.entries(entries)) disk[type][id] = clone(value);
                }
            },
        }, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
        return DEFAULT_CONNECTION_CONFIG.makeSignalRepository({ creds, keys }, logger, async () => []);
    };
    return { creds, reload, repository: reload() };
}

test('100 real Signal messages decrypt across concurrent sends, bidirectional traffic, and store reloads', async () => {
    const bot = endpoint(), phone = endpoint();
    const botJid = '123:7@s.whatsapp.net', phoneJid = '123@s.whatsapp.net';
    await bot.repository.injectE2ESession({ jid: phoneJid, session: {
        registrationId: phone.creds.registrationId,
        identityKey: generateSignalPubKey(phone.creds.signedIdentityKey.public),
        signedPreKey: {
            keyId: phone.creds.signedPreKey.keyId,
            publicKey: generateSignalPubKey(phone.creds.signedPreKey.keyPair.public),
            signature: phone.creds.signedPreKey.signature,
        },
    } });
    const send = async (sender, receiver, to, from, text) => {
        const encrypted = await sender.repository.encryptMessage({ jid: to, data: Buffer.from(text) });
        const plaintext = await receiver.repository.decryptMessage({ jid: from, type: encrypted.type, ciphertext: encrypted.ciphertext });
        assert.equal(Buffer.from(plaintext).toString(), text);
    };
    await send(bot, phone, phoneJid, botJid, 'first reply');
    await send(phone, bot, botJid, phoneJid, 'phone acknowledgement');
    for (let batch = 0; batch < 10; batch++) {
        await Promise.all(Array.from({ length: 10 }, (_, index) =>
            send(bot, phone, phoneJid, botJid, `reply ${batch * 10 + index}`)));
        await send(phone, bot, botJid, phoneJid, `command ${batch}`);
        bot.repository = bot.reload();
        phone.repository = phone.reload();
    }
});
