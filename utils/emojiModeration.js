import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

// Regex to detect emojis (covers most common emoji ranges)
const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}\u{FE0F}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F251}]/u;

export async function moderateGroupEmoji(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check if it's a group and has text content
    const textMsg = messageContent?.conversation || messageContent?.extendedTextMessage?.text;
    
    // Don't moderate if:
    // 1. Not a group
    // 2. No text content
    // 3. Has media (we only check text messages)
    const hasMedia = messageContent?.imageMessage || messageContent?.videoMessage || 
                    messageContent?.audioMessage || messageContent?.documentMessage || 
                    messageContent?.stickerMessage || messageContent?.ptvMessage;
    
    if (!jid?.endsWith('@g.us') || !textMsg || hasMedia) return false;
    
    // Check if emoji moderation is enabled for this group (OFF by default)
    if (!global.emojiModerationGroups || global.emojiModerationGroups[jid] !== true) {
        return false; // Moderation is OFF by default, allow emojis
    }
    
    // Check if message contains emojis
    if (!emojiRegex.test(textMsg)) {
        return false; // No emojis found, allow message
    }
    
    const event = `[emoji-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected emoji in message`);
    
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
        
        // Delete the message containing emojis
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} message with emoji deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
