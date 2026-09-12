import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

export async function moderateGroupVoice(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check if it's a group and has an audio message with ptt (push-to-talk) flag
    const audioMsg = messageContent?.audioMessage;
    if (!jid?.endsWith('@g.us') || !audioMsg || !audioMsg.ptt) return false;
    
    // Check if voice moderation is disabled for this group
    if (global.voiceModerationGroups && global.voiceModerationGroups[jid] === false) {
        return false; // Moderation is OFF, allow voice notes
    }
    
    const event = `[voice-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected voice note`);
    
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
                return false; // Don't delete admin voice notes
            }
        } catch (err) {
            console.warn(`${event} failed to check admin status:`, err.message);
            return false; // If we can't check, don't delete (safer)
        }
        
        // Delete the voice note (only non-admin members)
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} voice note deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
