import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

export async function moderateGroupText(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check if it's a group and has text content
    const textMsg = messageContent?.conversation || messageContent?.extendedTextMessage?.text;
    
    // Don't moderate if:
    // 1. Not a group
    // 2. No text content
    // 3. Has media (we only want pure text messages)
    const hasMedia = messageContent?.imageMessage || messageContent?.videoMessage || 
                    messageContent?.audioMessage || messageContent?.documentMessage || 
                    messageContent?.stickerMessage || messageContent?.ptvMessage;
    
    if (!jid?.endsWith('@g.us') || !textMsg || hasMedia) return false;
    
    // Check if text moderation is enabled for this group (OFF by default)
    if (!global.textModerationGroups || global.textModerationGroups[jid] !== true) {
        return false; // Moderation is OFF by default, allow text
    }
    
    const event = `[text-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected text message`);
    
    try {
        // Check if bot is a group admin
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
                return false; // Don't delete admin messages
            }
        } catch (err) {
            console.warn(`${event} failed to check admin status:`, err.message);
            return false; // If we can't check, don't delete (safer)
        }
        
        // Delete the text message (only non-admin members)
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} text message deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
