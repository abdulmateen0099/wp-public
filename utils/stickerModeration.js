import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';
import { userLabel } from './displayText.js';

export async function moderateGroupSticker(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@g.us') || !normalizeMessageContent(msg.message)?.stickerMessage) return false;
    const event = `[sticker-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected`);
    try {
        if (!await isGroupAdmin(sock, jid, [sock.user?.id, sock.user?.lid,
            sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid])) {
            console.warn(`${event} skipped: bot is not a group admin`);
            return true;
        }
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} delete sent`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    const sender = msg.key.participant || (msg.key.fromMe ? sock.user?.id : null);
    const normalized = sender ? jidNormalizedUser(sender) : null;
    const label = await userLabel(sock, normalized, {
        phoneJid: msg.key.participantAlt || msg.key.participantPn || msg.key.senderPn,
        name: msg.pushName,
    });
    try {
        await sock.sendMessage(jid, {
            text: `${label}, please don’t send stickers in this group again. Your sticker was deleted.`,
            mentions: normalized ? [normalized] : [],
        });
        console.log(`${event} warning sent`);
    } catch { console.warn(`${event} warning failed`); }
    return true;
}
