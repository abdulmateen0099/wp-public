import test from 'node:test';
import assert from 'node:assert/strict';
import remove from '../commands/remove.js';

const msg = { key: { remoteJid: 'group@g.us', participant: 'self@lid', fromMe: true } };
function fixture(admin = 'admin', count = 12) {
    const calls = [], replies = [];
    return {
        calls, replies, user: { id: '12345:1@s.whatsapp.net' },
        groupMetadata: async () => ({ subject: 'Test', owner: 'creator@lid', participants: [
            { id: 'self@lid', jid: '12345@s.whatsapp.net', admin },
            { id: 'creator@lid', admin: 'superadmin' },
            ...Array.from({ length: count }, (_, i) => ({ id: `${i + 100}@s.whatsapp.net`, admin: i === 0 ? 'admin' : null })),
        ] }),
        sendMessage: async (...args) => replies.push(args),
        groupParticipantsUpdate: async (...args) => {
            calls.push(args);
            return args[1].map(jid => ({ jid, status: '200' }));
        },
    };
}

test('remove targets other members including admins, keeps self and creator, reports privately', async () => {
    const sock = fixture();
    await remove.execute(sock, msg);
    assert.deepEqual(sock.calls.map(c => c[1].length), [10, 2]);
    assert.ok(sock.calls.every(c => c[0] === 'group@g.us' && c[2] === 'remove'));
    assert.ok(sock.calls.flatMap(c => c[1]).every(id => !['self@lid', 'creator@lid'].includes(id)));
    assert.equal(sock.replies[0][0], '12345@s.whatsapp.net');
    assert.match(sock.replies[0][1].text, /Confirmed removed: 12 of 12/);
});

test('remove rejects non-owners, private chats, and bot without admin permission', async () => {
    const outsider = fixture();
    await remove.execute(outsider, { key: { ...msg.key, participant: 'other@s.whatsapp.net', fromMe: false } });
    assert.equal(outsider.calls.length, 0);
    assert.equal(outsider.replies.length, 0);
    const privateSock = fixture();
    await remove.execute(privateSock, { key: { ...msg.key, remoteJid: '12345@s.whatsapp.net' } });
    assert.equal(privateSock.calls.length, 0);
    const nonAdmin = fixture(null);
    await remove.execute(nonAdmin, msg);
    assert.equal(nonAdmin.calls.length, 0);
    assert.match(nonAdmin.replies[0][1].text, /must be a group admin/);
});

test('remove stops on partial failures without claiming all members removed', async () => {
    const sock = fixture();
    sock.groupParticipantsUpdate = async (...args) => {
        sock.calls.push(args);
        return args[1].map((jid, i) => ({ jid, status: i === 0 ? '200' : '403' }));
    };
    await remove.execute(sock, msg);
    assert.equal(sock.calls.length, 1);
    assert.match(sock.replies[0][1].text, /Confirmed removed: 1 of 12/);
    assert.match(sock.replies[0][1].text, /Not attempted: 2/);
});

test('remove handles empty groups and does not retry uncertain network failures', async () => {
    const empty = fixture('admin', 0);
    await remove.execute(empty, msg);
    assert.equal(empty.calls.length, 0);
    const failed = fixture();
    failed.groupParticipantsUpdate = async (...args) => { failed.calls.push(args); throw new Error('network'); };
    await remove.execute(failed, msg);
    assert.equal(failed.calls.length, 1);
    assert.match(failed.replies[0][1].text, /Unconfirmed attempts: 10/);
});
