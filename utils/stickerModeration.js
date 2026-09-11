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
    // Notification removed - sticker deleted silently
    console.log(`${event} sticker deleted silently`);
    return true;
}
