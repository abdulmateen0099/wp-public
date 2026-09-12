import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

export async function moderateGroupViewOnce(sock, msg) {
    const jid = msg.key.remoteJid;
    
    // Check if it's a group
    if (!jid?.endsWith('@g.us')) return false;
    
    // Check if View Once moderation is disabled for this group (ON by default)
    if (global.viewOnceModerationGroups && global.viewOnceModerationGroups[jid] === false) {
        return false; // Moderation is OFF, allow View Once
    }
    
    // Check if it's a View Once message
    const isViewOnce = msg.key.isViewOnce || false;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check for View Once wrappers and any media inside them
    const hasViewOnce = messageContent?.viewOnceMessage || 
                       messageContent?.viewOnceMessageV2 || 
                       messageContent?.viewOnceMessageV2Extension ||
                       isViewOnce;
    
    if (!hasViewOnce) return false;
    
    const event = `[viewonce-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected View Once message`);
    
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
                return false; // Don't delete admin View Once messages
            }
        } catch (err) {
            console.warn(`${event} failed to check admin status:`, err.message);
            return false; // If we can't check, don't delete (safer)
        }
        
        // Delete the View Once message (only non-admin members)
        // This will delete ANY View Once content (photo, video, voice, etc.)
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} View Once message deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
