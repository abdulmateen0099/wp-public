import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { askGemini } from '../utils/gemini.js';
import { moderateGroupSticker } from '../utils/stickerModeration.js';
import { isGroupAdmin, requireGroupAdmin } from '../utils/groupAdmin.js';
import kick from '../commands/kick.js';
import add from '../commands/add.js';
import mute from '../commands/mute.js';
import unmute from '../commands/unmute.js';
import lnk from '../commands/lnk.js';
import vdt from '../commands/vdt.js';
import tagall from '../commands/tagall.js';
import { cleanOutgoingContent, userLabel } from '../utils/displayText.js';

const msg = { key: { id: 'sticker-1', remoteJid: 'group@g.us', participant: 'member@lid', fromMe: false }, message: { stickerMessage: {} } };
function socket(admin = true) {
    const calls = [];
    return {
        calls, user: { id: '12345:1@s.whatsapp.net', lid: 'bot@lid' },
        groupMetadata: async () => ({ participants: [{ id: 'bot@lid', admin: admin ? 'admin' : null }] }),
        sendMessage: async (...args) => { calls.push(args); },
        groupParticipantsUpdate: async (...args) => { calls.push(args); return [{ status: '200' }]; },
        groupSettingUpdate: async (...args) => { calls.push(args); },
    };
}
const ownerMessage = { ...msg, key: { ...msg.key, fromMe: true, participant: 'bot@lid' }, message: { conversation: '.add 923001234567' } };

test('display cleanup removes emojis and LID text while preserving routing and media', () => {
    const content = {
        text: '✅ From: 12345@lid', caption: '🤖 Hello @900:2@lid',
        mentions: ['12345@lid'], delete: { remoteJid: 'group@g.us', participant: '12345@lid' },
        sticker: Buffer.from('media'),
    };
    const cleaned = cleanOutgoingContent(content);
    assert.equal(cleaned.text, 'From: Member');
    assert.equal(cleaned.caption, 'Hello Member');
    assert.strictEqual(cleaned.mentions, content.mentions);
    assert.strictEqual(cleaned.delete, content.delete);
    assert.strictEqual(cleaned.sticker, content.sticker);
    assert.equal(content.text, '✅ From: 12345@lid');
});

test('member labels use names, phone alternatives or mappings without exposing internal IDs', async () => {
    assert.equal(await userLabel({}, '900@lid', { name: 'Mateen' }), 'Mateen');
    assert.equal(await userLabel({}, '900@lid', { phoneJid: '12345:2@s.whatsapp.net' }), '@12345');
    const sock = { signalRepository: { lidMapping: { getPNForLID: async () => '12345@s.whatsapp.net' } } };
    assert.equal(await userLabel(sock, '900@lid'), '@12345');
    sock.signalRepository.lidMapping.getPNForLID = async () => { throw new Error('missing'); };
    assert.equal(await userLabel(sock, '900@lid'), 'Member');
});

test('tagall renders clean member labels while retaining actual LID mention targets', async () => {
    const sock = socket();
    sock.groupMetadata = async () => ({ participants: [
        { id: 'bot@lid', jid: '12345@s.whatsapp.net', admin: 'admin' },
        { id: '900@lid', admin: null },
    ] });
    await tagall.execute(sock, ownerMessage, []);
    assert.doesNotMatch(sock.calls[0][1].text, /@lid|900/);
    assert.match(sock.calls[0][1].text, /@12345/);
    assert.deepEqual(sock.calls[0][1].mentions, ['bot@lid', '900@lid']);
});

test('Gemini uses Google endpoint/header, preserves prompt, filters thought text', async () => {
    const result = await askGemini('hello', { apiKey: 'test-key', post: async (url, body, options) => {
        assert.match(url, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\//);
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        assert.ok(options.timeout > 0 && options.timeout <= 30000);
        assert.equal(body.contents[0].parts[0].text, 'hello');
        return { data: { candidates: [{ content: { parts: [{ text: 'internal', thought: true }, { text: 'Hi' }] } }] } };
    } });
    assert.equal(result, 'Hi');
});

test('Gemini failures are actionable and never leak request credentials or raw errors', async () => {
    for (const [status, pattern] of [[403, /permissions/], [429, /quota/], [404, /model/], [503, /temporarily busy/]]) {
        await assert.rejects(askGemini('hi', { apiKey: 'secret', sleep: async () => {}, post: async () => {
            throw { message: 'secret', response: { status }, config: { headers: { key: 'secret' } } };
        } }), err => pattern.test(err.message) && !err.message.includes('secret'));
    }
    await assert.rejects(askGemini('hi', { apiKey: '' }), /GEMINI_API_KEY/);
    await assert.rejects(askGemini('hi', { apiKey: 'test', post: async () => ({ data: { candidates: [] } }) }), /no text/);
    await assert.rejects(askGemini('hi', { apiKey: 'test', post: async () => ({ data: { promptFeedback: { blockReason: 'SAFETY' } } }) }), /rephrasing/);
});

test('Gemini retries overload then uses fallback, with bounded exponential delays', async () => {
    const urls = [], delays = [];
    const answer = await askGemini('hi', {
        apiKey: 'test', model: 'primary', fallbackModel: 'fallback',
        sleep: async ms => { delays.push(ms); },
        post: async url => {
            urls.push(url);
            if (urls.length < 3) throw { response: { status: 503 } };
            return { data: { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] } };
        },
    });
    assert.equal(answer, 'Hello');
    assert.deepEqual(urls.map(url => url.split('/').at(-1)), ['primary:generateContent', 'primary:generateContent', 'fallback:generateContent']);
    assert.deepEqual(delays, [750, 1500]);
});

test('Gemini does not retry invalid credentials, quota errors, or blocked content', async () => {
    for (const status of [400, 401, 403, 404, 429]) {
        let attempts = 0;
        await assert.rejects(askGemini('hi', { apiKey: 'test', post: async () => {
            attempts++; throw { response: { status } };
        }, sleep: async () => assert.fail('Must not sleep') }));
        assert.equal(attempts, 1);
    }
    let attempts = 0;
    await assert.rejects(askGemini('hi', { apiKey: 'test', post: async () => {
        attempts++; return { data: { promptFeedback: { blockReason: 'SAFETY' } } };
    } }), /rephrasing/);
    assert.equal(attempts, 1);
});

test('Gemini stops after configured retries when every model is overloaded', async () => {
    let attempts = 0;
    await assert.rejects(askGemini('hi', { apiKey: 'test', fallbackModel: '',
        sleep: async () => {}, post: async () => { attempts++; throw { response: { status: 503 } }; },
    }), /temporarily busy/);
    assert.equal(attempts, 2);
});

test('group stickers are deleted silently in source group, including wrapped stickers', async () => {
    for (const content of [msg.message, { ephemeralMessage: { message: msg.message } }]) {
        const sock = socket();
        assert.equal(await moderateGroupSticker(sock, { ...msg, message: content }), true);
        assert.equal(sock.calls.length, 1);
        assert.equal(sock.calls[0][0], 'group@g.us');
        assert.deepEqual(sock.calls[0][1], { delete: msg.key });
    }
});

test('moderation skips private stickers and normal text; no false warning without delete', async () => {
    const sock = socket();
    assert.equal(await moderateGroupSticker(sock, { ...msg, key: { ...msg.key, remoteJid: 'member@lid' } }), false);
    assert.equal(await moderateGroupSticker(sock, { ...msg, message: { conversation: 'hello' } }), false);
    assert.equal(sock.calls.length, 0);
    const denied = socket(false);
    await moderateGroupSticker(denied, msg);
    assert.equal(denied.calls.length, 0);
    const failed = socket();
    let attempts = 0;
    failed.sendMessage = async () => { attempts++; throw new Error('403'); };
    await moderateGroupSticker(failed, msg);
    assert.equal(attempts, 1);
});

test('Baileys 6 LID participant with phone in jid is recognized as the bot admin', async () => {
    const sock = socket();
    sock.user = { id: '12345:7@s.whatsapp.net' };
    sock.groupMetadata = async () => ({ participants: [
        { id: '900@lid', jid: '12345@s.whatsapp.net', lid: '900@lid', admin: 'admin' },
    ] });
    await moderateGroupSticker(sock, msg);
    assert.equal(sock.calls.length, 1);
    assert.deepEqual(sock.calls[0][1], { delete: msg.key });
});

test('authenticated LID identifies bot when socket user has only phone identity', async () => {
    const sock = socket();
    sock.user = { id: '12345:7@s.whatsapp.net' };
    sock.authState = { creds: { me: { lid: 'bot:7@lid' } } };
    await moderateGroupSticker(sock, msg);
    assert.equal(sock.calls.length, 1);
});

test('matching group metadata succeeds without an unnecessary failing LID lookup', async () => {
    const sock = socket();
    sock.signalRepository = { lidMapping: { getPNForLID: async () => { throw new Error('unavailable'); } } };
    assert.equal(await isGroupAdmin(sock, 'group@g.us', [sock.user.id, sock.user.lid]), true);
    sock.groupMetadata = async () => ({ participants: [{ id: '900@lid', jid: '12345@s.whatsapp.net', admin: null }] });
    assert.equal(await isGroupAdmin(sock, 'group@g.us', [sock.user.id]), false);
});

test('add accepts owner and reports privacy failures without claiming success', async () => {
    const sock = socket();
    await add.execute(sock, ownerMessage, ['+923001234567']);
    assert.deepEqual(sock.calls[0], ['group@g.us', ['923001234567@s.whatsapp.net'], 'add']);
    assert.match(sock.calls[1][1].text, /Added/);
    sock.calls.length = 0;
    sock.groupParticipantsUpdate = async () => [{ status: '403' }];
    await add.execute(sock, ownerMessage, ['923001234567']);
    assert.match(sock.calls[0][1].text, /privacy settings/);
    const denied = socket(false);
    await add.execute(denied, msg, ['923001234567']);
    assert.equal(denied.calls.length, 1);
    assert.match(denied.calls[0][1].text, /Only the bot owner or group admins/);
    const invalid = socket();
    await add.execute(invalid, ownerMessage, ['abc']);
    assert.match(invalid.calls[0][1].text, /Usage/);
});

test('owner can run every group command with or without group admin role', async () => {
    const previousLinks = global.antiLinkGroups;
    try {
        for (const admin of [false, true]) {
            const sock = socket(admin);
            global.antiLinkGroups = {};
            await tagall.execute(sock, ownerMessage, ['Hello']);
            assert.deepEqual(sock.calls.at(-1)[1].mentions, ['bot@lid']);
            await lnk.execute(sock, { ...ownerMessage, message: { conversation: '.lnkon' } }, []);
            assert.notEqual(global.antiLinkGroups['group@g.us'], false);
            await lnk.execute(sock, { ...ownerMessage, message: { conversation: '.lnkoff' } }, []);
            assert.equal(global.antiLinkGroups['group@g.us'], false);
            await add.execute(sock, ownerMessage, ['923001234567']);
            assert.equal(sock.calls.at(-2)[2], 'add');
            await mute.execute(sock, ownerMessage, []);
            assert.equal(sock.calls.at(-2)[1], 'announcement');
            await unmute.execute(sock, ownerMessage, []);
            assert.equal(sock.calls.at(-2)[1], 'not_announcement');
            const target = '923001234567@s.whatsapp.net';
            sock.groupParticipantsUpdate = async (...args) => {
                sock.calls.push(args);
                return [{ jid: target, status: '200' }];
            };
            const kickMessage = { ...ownerMessage, message: {
                extendedTextMessage: { contextInfo: { mentionedJid: [target] } },
            } };
            await kick.execute(sock, kickMessage, []);
            assert.deepEqual(sock.calls.at(-2), ['group@g.us', [target], 'remove']);
            assert.match(sock.calls.at(-1)[1].text, /Removed 1 member/);
            sock.groupParticipantsUpdate = async () => [{ jid: target, status: '403' }];
            await kick.execute(sock, kickMessage, []);
            assert.match(sock.calls.at(-1)[1].text, /Removed 0 of 1/);
            sock.groupSettingUpdate = async () => { throw new Error('forbidden'); };
            await mute.execute(sock, ownerMessage, []);
            assert.match(sock.calls.at(-1)[1].text, /Make the bot a group admin/);
        }
    } finally {
        global.antiLinkGroups = previousLinks;
    }
});

test('owner group permission accepts phone and mapped LID but rejects private chats and other members', async () => {
    const sock = socket(false);
    sock.groupMetadata = async () => { throw new Error('Owner does not need metadata permission checks'); };
    assert.equal(await requireGroupAdmin(sock, ownerMessage), true);
    const phoneMessage = { ...msg, key: { ...msg.key, participant: '12345@s.whatsapp.net' } };
    assert.equal(await requireGroupAdmin(sock, phoneMessage), true);
    sock.signalRepository = { lidMapping: { getPNForLID: async () => '12345@s.whatsapp.net' } };
    assert.equal(await requireGroupAdmin(sock, { ...msg, key: { ...msg.key, participant: 'bot@lid' } }), true);
    assert.equal(await requireGroupAdmin(sock, { ...ownerMessage, key: { ...ownerMessage.key, remoteJid: '12345@s.whatsapp.net' } }), false);
    assert.match(sock.calls.at(-1)[1].text, /only works in groups/);
    assert.equal(await requireGroupAdmin(socket(false), msg), false);
});

test('mute and unmute select the correct group setting using LID admin identity', async () => {
    const sock = socket();
    await mute.execute(sock, ownerMessage, []);
    assert.deepEqual(sock.calls[0], ['group@g.us', 'announcement']);
    await unmute.execute(sock, ownerMessage, []);
    assert.deepEqual(sock.calls[2], ['group@g.us', 'not_announcement']);
});

test('renamed link toggle uses LID admin check and vdt shows status', async () => {
    const previousLinks = global.antiLinkGroups;
    try {
        global.antiLinkGroups = {};
        const sock = socket();
        await lnk.execute(sock, { ...ownerMessage, message: { conversation: '.lnkon' } }, []);
        assert.notEqual(global.antiLinkGroups['group@g.us'], false);
        await lnk.execute(sock, { ...ownerMessage, message: { conversation: '.lnkoff' } }, []);
        assert.equal(global.antiLinkGroups['group@g.us'], false);
        await vdt.execute(sock, ownerMessage, []);
        assert.match(sock.calls.at(-1)[1].text, /Group Delete Recovery Status/);
    } finally {
        global.antiLinkGroups = previousLinks;
    }
});

test('command directory contains the requested names and no removed commands or aliases', async () => {
    const commands = [];
    for (const file of await fs.readdir(new URL('../commands/', import.meta.url))) {
        if (file.endsWith('.js')) commands.push((await import(new URL(`../commands/${file}`, import.meta.url))).default);
    }
    const names = commands.flatMap(cmd => [cmd.name, ...(cmd.aliases || [])]);
    for (const name of ['ai', 'vdt', 'str', 'lnk', 'add', 'mute', 'unmute', 'op', 'kick', 'remove']) assert.ok(names.includes(name), name);
    for (const name of ['broadcast', 'brodcast', 'download', 'vdeletemsg', 'vdeletemg', 'sticker', 'antilink']) assert.ok(!names.includes(name), name);
});
