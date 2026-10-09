import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DEFAULT_CONNECTION_CONFIG, DisconnectReason, proto, WAMessageStubType } from '@whiskeysockets/baileys';
import { PersonalRecovery, isPersonalChat } from '../utils/personalRecovery.js';
import * as routing from '../utils/messageRouting.js';
import MessageStore from '../utils/messageStore.js';
import { cleanOutgoingContent, userLabel } from '../utils/displayText.js';
import { moderateGroupSticker } from '../utils/stickerModeration.js';
import { moderateGroupVoice } from '../utils/voiceModeration.js';
import { moderateGroupPhoto } from '../utils/photoModeration.js';
import { moderateGroupVideo } from '../utils/videoModeration.js';
import { moderateGroupDocument } from '../utils/documentModeration.js';
import { moderateGroupText } from '../utils/textModeration.js';
import { moderateGroupEmoji } from '../utils/emojiModeration.js';
import { moderateGroupViewOnce } from '../utils/viewOnceModeration.js';
import ping from '../commands/ping.js';
import op from '../commands/op.js';
import menu from '../commands/menu.js';
import vdt from '../commands/vdt.js';

const source = fs.readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
function harness() {
    const sockets = [], timers = [], sent = [], encryption = [];
    const commands = new Map([['ping', ping], ['op', op]]);
    const context = vm.createContext({
        ...routing, MessageStore, DEFAULT_CONNECTION_CONFIG, PersonalRecovery, isPersonalChat, WAMessageStubType, cleanOutgoingContent, userLabel, moderateGroupSticker, path, proto, DisconnectReason, commands,
        moderateGroupVoice, moderateGroupPhoto, moderateGroupVideo, moderateGroupDocument, moderateGroupText, moderateGroupEmoji, moderateGroupViewOnce,
        sessionsBaseDir: '/fake', __dirname: '/fake', PREFIX: '.', OWNER_NUMBER: '12345',
        process: { env: {} }, console: { log() {}, warn() {}, error() {} },
        fs: { existsSync: () => true, readdirSync: () => [], rmSync() {} },
        global: { messageCache: new MessageStore(), antiDeleteEnabled: {}, antiLinkGroups: {} },
        pino: () => ({}), Browsers: { ubuntu: () => [] },
        fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1] }),
        useMultiFileAuthState: async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds() {} }),
        makeCacheableSignalKeyStore: keys => keys,
        setTimeout(fn) { const timer = { fn, cancelled: false }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cancelled = true; },
        makeWASocket(config) {
            const handlers = new Map();
            const sock = {
                config, handlers, user: { id: '12345:1@s.whatsapp.net' },
                ev: { on: (event, fn) => handlers.set(event, fn), removeAllListeners: () => handlers.clear() },
                end() {}, sendMessage: async (...args) => {
                    sent.push(args);
                    return { key: { id: `sent-${sent.length}`, remoteJid: args[0], fromMe: true }, message: { conversation: args[1].text } };
                },
                getUSyncDevices: async (...args) => {
                    encryption.push(['devices', ...args]);
                    return [{ user: '12345', device: 2 }];
                },
                assertSessions: async (...args) => { encryption.push(['sessions', ...args]); },
            };
            sockets.push(sock);
            return sock;
        },
    });
    vm.runInContext(
        section('class WhatsAppSession', 'const activeSessions') +
        section('async function startSession', '// ─── Utility: Extract media') +
        section('async function handleMessageUpdate', '// Ensure this is global') +
        section('function extractMessageText', '// ─── Initialize All Sessions') +
        '\nthis.Session = WhatsAppSession;', context);
    return { context, sockets, timers, sent, commands, encryption };
}
const message = (id, text = '.ping', extra = {}) => ({
    key: { id, remoteJid: '98765@s.whatsapp.net', fromMe: true, ...extra },
    message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000),
});

test('sockets use upstream Signal handling without forcibly resetting sessions', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    assert.equal(sock.config.makeSignalRepository, undefined);
    for (let i = 0; i < 20; i++) await sock.sendMessage('12345@s.whatsapp.net', { text: 'reply ' + i });
    assert.equal(h.sent.length, 20);
    assert.equal(h.encryption.length, 0);
});

test('notify and fresh append execute once per session; old history does not execute', async () => {
    const h = harness();
    const session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    const receive = sock.handlers.get('messages.upsert');
    const a = message('a');
    await receive({ type: 'append', messages: [a, message('b')] });
    await receive({ type: 'notify', messages: [a] });
    await receive({ type: 'append', messages: [{ ...message('old'), messageTimestamp: 1 }] });
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0][0], '12345@s.whatsapp.net');
    assert.equal(h.sent[0][2].quoted, undefined);
    const second = new h.context.Session('second');
    const otherSock = await h.context.startSession(second);
    await otherSock.handlers.get('messages.upsert')({ type: 'notify', messages: [a] });
    assert.equal(h.sent.length, 3);
    assert.equal(sock.config.shouldSyncHistoryMessage(), false);
});

test('owner phone and LID identities accepted; non-owner rejected', async () => {
    for (const key of [
        { remoteJid: '12345:7@s.whatsapp.net' },
        { remoteJid: '900@lid', senderPn: '12345@s.whatsapp.net' },
        { remoteJid: '900@lid', remoteJidAlt: '12345@s.whatsapp.net' },
        { remoteJid: 'g@g.us', participant: '900@lid', participantPn: '12345@s.whatsapp.net' },
    ]) assert.equal(await routing.isOwnerMessage({}, { key }, '12345', '111'), true);
    assert.equal(await routing.isOwnerMessage({}, { key: { remoteJid: '12345@lid' } }, '12345', '111'), false);
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    await sock.handlers.get('messages.upsert')({ type: 'notify', messages: [message('outsider', '.ping', { fromMe: false })] });
    assert.equal(h.sent.length, 0);
});

test('wrapped command with whitespace keeps quoted context for .op', async () => {
    const h = harness(), session = new h.context.Session('primary');
    let received;
    h.commands.set('op', { execute: async (_sock, msg) => { received = msg; } });
    const sock = await h.context.startSession(session);
    const msg = message('wrapped');
    msg.message = { ephemeralMessage: { message: { extendedTextMessage: {
        text: '  .op ', contextInfo: { quotedMessage: { imageMessage: { viewOnce: true } } },
    } } } };
    await sock.handlers.get('messages.upsert')({ type: 'notify', messages: [msg] });
    assert.equal(received.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage.viewOnce, true);
    assert.equal(op.name, 'op');
});

test('515 reconnect restores once and cleanup cancels stale reconnect', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    await sock.handlers.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    assert.equal(session.state, 'disconnected');
    assert.equal(h.timers.length, 1);
    await h.timers[0].fn();
    assert.equal(h.sockets.length, 2);
    assert.equal(session.mode, 'restore');
    await h.sockets[1].handlers.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await session.cleanup();
    await h.timers[1].fn();
    assert.equal(h.sockets.length, 2);
    assert.equal(h.timers[1].cancelled, true);
});

test('concurrent start requests leave only one socket', async () => {
    const h = harness(), session = new h.context.Session('primary');
    await Promise.all([h.context.startSession(session), h.context.startSession(session)]);
    assert.equal(h.sockets.length, 1);
});

test('401 clears once and never schedules a reconnect; 440 does not fight another process', async () => {
    for (const code of [401, 440]) {
        const h = harness(), session = new h.context.Session('primary');
        let clears = 0;
        session.clearAuth = () => { clears++; };
        const sock = await h.context.startSession(session);
        await sock.handlers.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
        assert.equal(clears, code === 401 ? 1 : 0);
        assert.equal(h.timers.length, 0);
    }
});

test('deduplication storage stays bounded', () => {
    const seen = new Set();
    for (let i = 0; i < 11000; i++) routing.rememberMessage(seen, String(i));
    assert.equal(seen.size, 10000);
    assert.equal(routing.rememberMessage(seen, '10999'), false);
});

test('delivery retry can retrieve sent replies across reconnects, with account isolation', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    const sent = await sock.sendMessage('12345@s.whatsapp.net', { text: 'Retry this reply' });
    assert.equal((await sock.config.getMessage(sent.key)).conversation, 'Retry this reply');
    const reconnected = await h.context.startSession(session);
    assert.equal((await reconnected.config.getMessage(sent.key)).conversation, 'Retry this reply');
    const other = await h.context.startSession(new h.context.Session('other'));
    assert.equal(await other.config.getMessage(sent.key), undefined);
    assert.equal(await sock.config.getMessage({ id: 'missing' }), undefined);
});

test('all outgoing replies clean visible content and go to owner while preserving mention identities', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    await sock.sendMessage('900@lid', { text: '✅ Hello 900@lid', mentions: ['900@lid'] });
    assert.equal(h.sent[0][0], '12345@s.whatsapp.net');
    assert.equal(h.sent[0][1].text, 'Hello Member');
    assert.deepEqual(h.sent[0][1].mentions, ['900@lid']);
    assert.equal((await sock.config.getMessage({ id: 'sent-1' })).conversation, 'Hello Member');
});

test('menu, renamed anti-delete command, and unknown command reply in self-chat', async () => {
    const h = harness(), session = new h.context.Session('primary');
    h.commands.set('menu', menu);
    h.commands.set('vdt', vdt);
    const sock = await h.context.startSession(session);
    const receive = sock.handlers.get('messages.upsert');
    await receive({ type: 'notify', messages: [message('menu', '.menu', { remoteJid: '12345@s.whatsapp.net' })] });
    assert.match(h.sent[0][1].text, /BOT COMMAND MENU/);
    assert.match(h.sent[0][1].text, /vdt/);
    assert.equal(h.sent[0][2].quoted, undefined);
    // Use a stub to verify dispatch without sharing globals between VM and test modules.
    let invoked = false;
    h.commands.set('vdt', { ...vdt, execute: async () => { invoked = true; } });
    await receive({ type: 'notify', messages: [message('renamed', '.vdt')] });
    assert.equal(invoked, true);
    await receive({ type: 'notify', messages: [message('unknown', '.doesnotexist', { remoteJid: '12345@s.whatsapp.net' })] });
    assert.match(h.sent.at(-1)[1].text, /Unknown Command/);
});

test('tagall posts only in the source group while other replies and tagall errors stay private', async () => {
    const h = harness(), session = new h.context.Session('primary');
    h.commands.set('direct', { name: 'direct', execute: async (sock, msg) => {
        await sock.sendMessage('12345@s.whatsapp.net', { text: 'private result' }, { quoted: msg });
    } });
    h.commands.set('tagall', { name: 'tagall', execute: async (sock, msg) => {
        await sock.sendMessage(msg.key.remoteJid, { text: 'group result', mentions: ['67890@s.whatsapp.net'] }, { quoted: msg });
        await sock.sendMessage(msg.key.remoteJid, { text: 'tagall error' }, { quoted: msg });
    } });
    const sock = await h.context.startSession(session);
    const receive = sock.handlers.get('messages.upsert');
    await receive({ type: 'notify', messages: [message('direct', '.direct', { remoteJid: 'group@g.us' })] });
    assert.equal(h.sent[0][0], '12345@s.whatsapp.net');
    assert.equal(h.sent[0][2].quoted, undefined);
    await receive({ type: 'notify', messages: [message('tags', '.TAGALL', { remoteJid: 'group@g.us' })] });
    assert.equal(h.sent[1][0], 'group@g.us');
    assert.equal(h.sent[1][2].quoted.key.id, 'tags');
    assert.equal(h.sent[1][2].groupTagAll, undefined);
    assert.equal(h.sent[2][0], '12345@s.whatsapp.net');
    assert.equal(h.sent[2][2].quoted, undefined);
    assert.equal(h.sent.length, 3);
});

test('sticker moderation runs for non-owners, only once, and is excluded from anti-delete cache', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    sock.groupMetadata = async () => ({ participants: [{ id: '12345@s.whatsapp.net', admin: 'admin' }] });
    const sticker = message('ban-sticker', '', { remoteJid: 'group@g.us', participant: '67890@s.whatsapp.net', fromMe: false });
    sticker.message = { stickerMessage: {} };
    const receive = sock.handlers.get('messages.upsert');
    await receive({ type: 'notify', messages: [sticker] });
    await receive({ type: 'notify', messages: [sticker] });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0][0], 'group@g.us');
    assert.equal(h.context.global.messageCache.get('group@g.us_ban-sticker'), null);
});

test('join and leave events produce no bot notices for any session', async () => {
    const h = harness();
    for (const number of ['12345', '67890']) {
        const session = new h.context.Session(number);
        session.user = { number };
        const sock = await h.context.startSession(session);
        sock.groupMetadata = async () => ({ subject: 'Test group', participants: [] });
        for (const action of ['add', 'remove']) {
            await sock.handlers.get('group-participants.update')?.({ id: 'group@g.us', participants: ['99999@s.whatsapp.net'], action });
        }
    }
    assert.equal(h.sent.length, 0);
});

test('privacy boundary redirects media, suppresses public reactions, and never falls back to group without an owner', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const sock = await h.context.startSession(session);
    await sock.sendMessage('group@g.us', { image: Buffer.from('image'), caption: 'result' }, { quoted: message('source') });
    assert.equal(h.sent[0][0], '12345@s.whatsapp.net');
    assert.equal(h.sent[0][2].quoted, undefined);
    await sock.sendMessage('group@g.us', { react: { text: 'OK', key: message('source').key } });
    sock.user = null;
    await sock.sendMessage('group@g.us', { text: 'must not leak' });
    assert.equal(h.sent.length, 1);
});

test('personal auto-save and both revoke delivery paths work without commands; groups remain excluded', async () => {
    const h = harness(), session = new h.context.Session('primary');
    session.personalRecovery = new PersonalRecovery({ download: async () => (async function* () { yield Buffer.from('media'); })() });
    const sock = await h.context.startSession(session);
    const receive = sock.handlers.get('messages.upsert');
    const jid = '98765@s.whatsapp.net';
    const incoming = message('original', 'Private text', { fromMe: false });
    await receive({ type: 'notify', messages: [incoming] });
    assert.equal(h.sent.length, 0);
    const revoke = { ...message('revoke', '', { fromMe: false }), message: { protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'original', remoteJid: jid },
    } } };
    await receive({ type: 'notify', messages: [revoke] });
    assert.match(h.sent[0][1].text, /From: \+98765[\s\S]*Message: Private text/);
    await sock.handlers.get('messages.update')([{ key: { remoteJid: jid, id: 'original' }, update: { messageStubType: WAMessageStubType.REVOKE } }]);
    assert.equal(h.sent.length, 1);
    await receive({ type: 'notify', messages: [message('second', 'Second text', { fromMe: false })] });
    await sock.handlers.get('messages.update')([{ key: { remoteJid: jid, id: 'event-id' }, update: { message: {
        protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'second' } },
    } } }]);
    assert.match(h.sent[1][1].text, /Second text/);
    const view = { ...message('view', '', { fromMe: false }), message: { viewOnceMessageV2: { message: { imageMessage: {} } } } };
    await receive({ type: 'notify', messages: [view] });
    assert.ok(Buffer.isBuffer(h.sent[2][1].image));
    assert.match(h.sent[2][1].caption, /From: \+98765/);
    h.context.global.antiDeleteEnabled['group@g.us'] = true;
    const groupView = { ...view, key: { ...view.key, id: 'group-view', remoteJid: 'group@g.us', participant: jid } };
    await receive({ type: 'notify', messages: [groupView] });
    await sock.handlers.get('messages.update')([{ key: groupView.key, update: { messageStubType: WAMessageStubType.REVOKE } }]);
    assert.equal(h.sent.length, 3);
    assert.ok(h.sent.every(([target]) => target === '12345@s.whatsapp.net'));
});

test('View Once media delivered after placeholder is saved via updates and same-ID upserts', async () => {
    const h = harness(), session = new h.context.Session('primary');
    session.personalRecovery = new PersonalRecovery({ download: async () => (async function* () { yield Buffer.from('media'); })() });
    const sock = await h.context.startSession(session);
    const receive = sock.handlers.get('messages.upsert');
    for (const route of ['update', 'upsert']) {
        const original = message(route, '', { fromMe: false });
        await receive({ type: 'notify', messages: [original] });
        const media = { viewOnceMessageV2: { message: { imageMessage: {} } } };
        if (route === 'update') {
            await sock.handlers.get('messages.update')([{ key: original.key, update: { message: media } }]);
        } else {
            await receive({ type: 'notify', messages: [{ ...original, message: media }] });
        }
    }
    assert.equal(h.sent.length, 2);
    assert.ok(h.sent.every(([jid, content]) => jid === '12345@s.whatsapp.net' && Buffer.isBuffer(content.image)));
});

test('empty key-flagged View Once is not discarded and later unflagged media saves to self-chat', async () => {
    const h = harness(), session = new h.context.Session('primary');
    session.personalRecovery = new PersonalRecovery({ download: async () => (async function* () { yield Buffer.from('real-media'); })() });
    const sock = await h.context.startSession(session);
    const placeholder = { ...message('empty-view', '', { fromMe: false, isViewOnce: true }), message: undefined };
    await sock.handlers.get('messages.upsert')({ type: 'notify', messages: [placeholder] });
    // No notification sent for placeholder
    assert.equal(h.sent.length, 0);
    const incoming = { ...message('empty-view', '', { fromMe: false }), message: { videoMessage: {} } };
    await sock.handlers.get('messages.upsert')({ type: 'notify', messages: [incoming] });
    assert.ok(Buffer.isBuffer(h.sent[0][1].video));
    assert.equal(h.sent[0][0], '12345@s.whatsapp.net');
});

test('dashboard status and command help run without deleted single-session globals', async () => {
    const h = harness(), session = new h.context.Session('primary');
    const routes = new Map();
    h.context.app = { post: (url, handler) => routes.set(url, handler) };
    h.context.getPrimarySession = () => session;
    h.context.addTerminalLog = () => {};
    h.context.process.memoryUsage = process.memoryUsage;
    h.context.process.uptime = process.uptime;
    vm.runInContext(section("app.post('/api/terminal/execute'", 'const dashboardServer'), h.context);
    let response;
    const res = { json: value => { response = value; }, status() { return this; } };
    const execute = routes.get('/api/terminal/execute');
    await execute({ body: { command: 'status' } }, res);
    assert.match(response.output, /State: IDLE/);
    await execute({ body: { command: '.op' } }, res);
    assert.match(response.output, /command help only/);
    await execute({ body: { command: 'logout' } }, res);
    assert.equal(session.state, 'idle');
});

test('WhatsApp startup waits for port ownership and port conflicts exit', async () => {
    let listening, onError, boots = 0, exitCode;
    const context = vm.createContext({
        PORT: 3000, console: { log() {}, error() {} },
        app: { listen(port, host, callback) {
            assert.equal(port, 3000);
            assert.equal(host, '0.0.0.0');
            listening = callback;
            return { on(event, callback) { assert.equal(event, 'error'); onError = callback; } };
        } },
        initAllSessions: async () => { boots++; },
        process: { exit: code => { exitCode = code; } },
    });
    vm.runInContext(section('const dashboardServer', '// ─── Global State'), context);
    assert.equal(boots, 0);
    listening({ code: 'EADDRINUSE' });
    assert.equal(boots, 0);
    onError({ code: 'EADDRINUSE' });
    assert.equal(exitCode, 1);
    assert.equal(boots, 0);
    listening();
    assert.equal(boots, 1);
});
