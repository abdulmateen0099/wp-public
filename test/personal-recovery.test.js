import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalRecovery } from '../utils/personalRecovery.js';
import { decryptMessageNode } from '@whiskeysockets/baileys';
import vdt from '../commands/vdt.js';

const message = (id, content, jid = '923001234567@s.whatsapp.net') => ({
    key: { id, remoteJid: jid, fromMe: false }, pushName: 'Friend', message: content,
});
function fixture(options = {}) {
    const sent = [];
    const sock = { user: { id: '923009999999:1@s.whatsapp.net' }, sendMessage: async (...args) => sent.push(args) };
    const downloads = [];
    const cache = new PersonalRecovery({ download: async (data, type) => {
        downloads.push(type);
        return (async function* () { yield Buffer.from('saved-media'); })();
    }, ...options });
    return { cache, sock, sent, downloads };
}

test('personal View Once wrappers and native flag save images/videos/documents with sender phone, despite pushName', async () => {
    for (const [key, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['documentMessage', 'document']]) {
        for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', null]) {
            const f = fixture();
            const media = { [key]: { caption: 'Original caption', viewOnce: true } };
            const content = wrapper ? { ephemeralMessage: { message: { [wrapper]: { message: media } } } } : media;
            await f.cache.receive(f.sock, message('v', content));
            assert.equal(f.sent.length, 1);
            assert.equal(f.sent[0][0], '923009999999@s.whatsapp.net');
            assert.ok(Buffer.isBuffer(f.sent[0][1][type]));
            assert.match(f.sent[0][1].caption, /From: \+923001234567/);
            assert.match(f.sent[0][1].caption, /Original caption/);
            assert.equal(f.sent[0][1].viewOnce, undefined);
        }
    }
});

test('voice View Once includes separate sender number and supports LID phone alternatives/mappings', async () => {
    for (const mapped of [true, false]) {
        const f = fixture();
        const msg = message('voice', { viewOnceMessageV2Extension: { message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } } } }, '900@lid');
        if (mapped) f.sock.signalRepository = { lidMapping: { getPNForLID: async () => '923001234567@s.whatsapp.net' } };
        else msg.key.remoteJidAlt = '923001234567@s.whatsapp.net';
        await f.cache.receive(f.sock, msg);
        assert.equal(f.sent.length, 2);
        assert.match(f.sent[0][1].text, /From: \+923001234567/);
        assert.equal(f.sent[1][1].ptt, true);
        assert.ok(f.sent.every(([jid]) => jid === '923009999999@s.whatsapp.net'));
    }
});

test('View Once media replaces an earlier same-ID placeholder and sends once', async () => {
    const f = fixture();
    await f.cache.receive(f.sock, message('late', { conversation: '' }));
    const late = message('late', { deviceSentMessage: { message: { associatedChildMessage: { message: {
        viewOnceMessageV2: { message: { imageMessage: {} } },
    } } } } });
    await f.cache.receive(f.sock, late);
    await f.cache.receive(f.sock, late);
    assert.equal(f.sent.length, 1);
    assert.ok(Buffer.isBuffer(f.sent[0][1].image));
    assert.match(f.sent[0][1].caption, /From: \+923001234567/);
});

test('expired View Once download is refreshed and retried once', async () => {
    const f = fixture();
    let attempts = 0, refreshes = 0;
    f.cache.download = async data => {
        attempts++;
        if (data.url === 'expired') throw Object.assign(new Error('expired'), { response: { status: 410 } });
        return (async function* () { yield Buffer.from('fresh'); })();
    };
    f.sock.updateMediaMessage = async msg => {
        refreshes++;
        assert.equal(msg.key.id, 'expired');
        return { ...msg, message: { imageMessage: { url: 'fresh' } } };
    };
    await f.cache.receive(f.sock, message('expired', { viewOnceMessageV2: { message: { imageMessage: { url: 'expired' } } } }));
    assert.equal(attempts, 2);
    assert.equal(refreshes, 1);
    assert.equal(f.sent[0][1].image.toString(), 'fresh');
});

test('failed View Once download can succeed on a later redelivery', async () => {
    const f = fixture();
    const download = f.cache.download;
    f.cache.download = async () => { throw new Error('temporarily unavailable'); };
    const msg = message('retry', { viewOnceMessage: { message: { videoMessage: {} } } });
    await f.cache.receive(f.sock, msg);
    // No error notification sent - we just cache the failed state
    assert.equal(f.sent.length, 0);
    f.cache.download = download;
    await f.cache.receive(f.sock, msg);
    assert.ok(Buffer.isBuffer(f.sent[0][1].video));
});

test('personal deleted text is recovered automatically once, even with duplicate revoke events', async () => {
    const f = fixture(), msg = message('text', { conversation: 'Original message' });
    await f.cache.receive(f.sock, msg);
    assert.equal(f.sent.length, 0);
    await Promise.all([f.cache.recover(f.sock, msg.key.remoteJid, 'text'), f.cache.recover(f.sock, msg.key.remoteJid, 'text')]);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0][1].text, /From: \+923001234567[\s\S]*Message: Original message/);
});

test('deleted media uses cached bytes without redownloading after revocation', async () => {
    for (const type of ['image', 'video', 'audio', 'document', 'sticker']) {
        const f = fixture(), msg = message(type, { [`${type}Message`]: {} });
        await f.cache.receive(f.sock, msg);
        f.cache.download = async () => { throw Error('media no longer available'); };
        await f.cache.recover(f.sock, msg.key.remoteJid, type);
        assert.equal(f.downloads.length, 1);
        assert.ok(Buffer.isBuffer(f.sent.at(-1)[1][type]));
        assert.match(f.sent[0][1].text || f.sent[0][1].caption, /From: \+923001234567/);
    }
});

test('groups, broadcasts, self-sent messages, and other accounts never auto-save or recover', async () => {
    const f = fixture();
    for (const jid of ['group@g.us', 'status@broadcast', '123@newsletter']) {
        await f.cache.receive(f.sock, message('x', { viewOnceMessage: { message: { imageMessage: {} } } }, jid));
        assert.equal(await f.cache.recover(f.sock, jid, 'x'), false);
    }
    const own = message('own', { conversation: 'own' });
    own.key.fromMe = true;
    await f.cache.receive(f.sock, own);
    assert.equal(await f.cache.recover(f.sock, own.key.remoteJid, 'own'), false);
    const incoming = message('other', { conversation: 'private' });
    await f.cache.receive(f.sock, incoming);
    assert.equal(await fixture().cache.recover(f.sock, incoming.key.remoteJid, 'other'), false);
    assert.equal(f.sent.length, 0);
    assert.equal(f.downloads.length, 0);
});

test('cache respects expiry/size bounds and reports unavailable media/phone honestly', async () => {
    let now = 0;
    const f = fixture({ maxEntries: 1, ttl: 10, now: () => now, maxMediaBytes: 2 });
    const one = message('one', { conversation: 'one' });
    await f.cache.receive(f.sock, one);
    await f.cache.receive(f.sock, message('two', { conversation: 'two' }));
    assert.equal(await f.cache.recover(f.sock, one.key.remoteJid, 'one'), false);
    now = 20;
    assert.equal(await f.cache.recover(f.sock, one.key.remoteJid, 'two'), false);
    // Large View Once media - no notification sent, just logged
    await f.cache.receive(f.sock, message('large', { imageMessage: { viewOnce: true } }, '900@lid'));
    // No notifications sent for failed View Once downloads
    assert.equal(f.sent.length, 0);
    assert.equal(f.cache.bytes, 0);
});

test('actual Baileys decoder View Once key flag survives missing payload and later plain media delivery', async () => {
    const f = fixture();
    const decoded = decryptMessageNode({ tag: 'message', attrs: {
        id: 'baileys-placeholder', from: '923001234567@s.whatsapp.net', t: '123',
    }, content: [{ tag: 'unavailable', attrs: { type: 'view_once' } }] }, f.sock.user.id, '', {}, { error() {} });
    await decoded.decrypt();
    assert.equal(decoded.fullMessage.key.isViewOnce, true);
    assert.equal(decoded.fullMessage.message, undefined);
    await f.cache.receive(f.sock, decoded.fullMessage);
    // No notification sent for placeholder
    assert.equal(f.sent.length, 0);
    // Phone resend can contain normal media, without repeating the wrapper/flag.
    await f.cache.receive(f.sock, message('baileys-placeholder', { imageMessage: {} }));
    assert.ok(Buffer.isBuffer(f.sent[0][1].image));
    assert.match(f.sent[0][1].caption, /Saved View Once/);
});

test('View Once key flag on unwrapped audio saves without a wrapper', async () => {
    const f = fixture(), msg = message('key-voice', { audioMessage: { ptt: true } });
    msg.key.isViewOnce = true;
    await f.cache.receive(f.sock, msg);
    assert.ok(Buffer.isBuffer(f.sent.at(-1)[1].audio));
});

test('late regular media updates remain recoverable and voice/photo/video above 8 MB can be cached', async () => {
    const f = fixture();
    const data = Buffer.alloc(9 * 1024 * 1024);
    f.cache.download = async () => (async function* () { yield data; })();
    for (const type of ['image', 'video', 'audio']) {
        await f.cache.receive(f.sock, message(type, {}));
        await f.cache.receive(f.sock, message(type, { [`${type}Message`]: { fileLength: data.length } }));
        await f.cache.recover(f.sock, '923001234567@s.whatsapp.net', type);
        assert.equal(f.sent.at(-1)[1][type].length, data.length);
    }
});

test('vdt uses per-account downloaded bytes for all personal content and supports manual repeat', async () => {
    for (const type of ['text', 'image', 'video', 'audio', 'document', 'sticker']) {
        const f = fixture(), session = { personalRecovery: f.cache };
        await f.cache.receive(f.sock, message(type, type === 'text' ? { conversation: 'Original text' } : { [`${type}Message`]: {} }));
        f.cache.download = async () => { throw Error('Must not redownload deleted media'); };
        const command = { key: { id: 'cmd', remoteJid: '923001234567@s.whatsapp.net', fromMe: true }, message: {
            extendedTextMessage: { contextInfo: { stanzaId: type } },
        } };
        await vdt.execute(f.sock, command, [], { session });
        if (type === 'text') assert.match(f.sent.at(-1)[1].text, /Original text/);
        else assert.ok(Buffer.isBuffer(f.sent.at(-1)[1][type]));
        const count = f.sent.length;
        await vdt.execute(f.sock, command, [], { session });
        assert.ok(f.sent.length > count);
        assert.ok(f.sent.every(([jid]) => jid === '923009999999@s.whatsapp.net'));
    }
});

test('deletion can use phone alias for LID original and a failed self-chat delivery remains retryable', async () => {
    const f = fixture(), msg = message('alias', { imageMessage: {} }, '900@lid');
    msg.key.senderPn = '923001234567@s.whatsapp.net';
    await f.cache.receive(f.sock, msg);
    const send = f.sock.sendMessage;
    f.sock.sendMessage = async () => { throw new Error('disconnected'); };
    await assert.rejects(f.cache.recover(f.sock, msg.key.senderPn, 'alias'));
    f.sock.sendMessage = send;
    assert.equal(await f.cache.recover(f.sock, msg.key.senderPn, 'alias'), true);
    assert.ok(Buffer.isBuffer(f.sent[0][1].image));
});

test('revoke arriving before original cache preparation is recovered once original becomes available', async () => {
    const f = fixture();
    await f.cache.recover(f.sock, '923001234567@s.whatsapp.net', 'fast');
    await f.cache.receive(f.sock, message('fast', { videoMessage: {} }));
    assert.ok(Buffer.isBuffer(f.sent[0][1].video));
});
