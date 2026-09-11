import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

export async function moderateGroupVoice(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check if it's a group and has an audio message with ptt (push-to-talk) flag
    const audioMsg = messageContent?.audioMessage;
    if (!jid?.endsWith('@g.us') || !audioMsg || !audioMsg.ptt) return false;
    
    const event = `[voice-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected voice note`);
    
    try {
        // Check if bot is a group admin
        if (!await isGroupAdmin(sock, jid, [sock.user?.id, sock.user?.lid,
            sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid])) {
            console.warn(`${event} skipped: bot is not a group admin`);
            return true;
        }
        
        // Delete the voice note
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} voice note deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
