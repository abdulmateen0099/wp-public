import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';
import { userLabel } from './displayText.js';

export async function moderateGroupSticker(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@g.us') || !normalizeMessageContent(msg.message)?.stickerMessage) return false;
    
    // Check if sticker moderation is disabled for this group
    if (global.stickerModerationGroups && global.stickerModerationGroups[jid] === false) {
        return false; // Moderation is OFF, allow stickers
    }
    
    const event = `[sticker-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected`);
    try {
        if (!await isGroupAdmin(sock, jid, [sock.user?.id, sock.user?.lid,
            sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid])) {
            console.warn(`${event} skipped: bot is not a group admin`);
            return true;
        }
        
        // Check if sender is a group admin - DON'T delete admin messages
        const sender = msg.key.participant || msg.key.remoteJid;
        try {
            const metadata = await sock.groupMetadata(jid);
            const isAdmin = metadata.participants.some(p => {
                return p.id.replace(/:\d+/, '') === sender.replace(/:\d+/, '') &&
                       (p.admin === 'admin' || p.admin === 'superadmin');
            });

            if (isAdmin) {
                console.log(`${event} skipped: sender is group admin`);
                return false; // Don't delete admin stickers
            }
        } catch (err) {
            console.warn(`${event} failed to check admin status:`, err.message);
            return false; // If we can't check, don't delete (safer)
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
