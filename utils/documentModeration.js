import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { isGroupAdmin } from './groupAdmin.js';

export async function moderateGroupDocument(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageContent = normalizeMessageContent(msg.message);
    
    // Check if it's a group and has a document message
    const docMsg = messageContent?.documentMessage;
    if (!jid?.endsWith('@g.us') || !docMsg) return false;
    
    // Check if document moderation is disabled for this group
    if (global.documentModerationGroups && global.documentModerationGroups[jid] === false) {
        return false; // Moderation is OFF, allow documents
    }
    
    const event = `[document-moderation] chat=${jid} message=${msg.key.id}`;
    console.log(`${event} detected document: ${docMsg.fileName || 'unnamed'}`);
    
    try {
        // Check if bot is a group admin
        if (!await isGroupAdmin(sock, jid, [sock.user?.id, sock.user?.lid,
            sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid])) {
            console.warn(`${event} skipped: bot is not a group admin`);
            return true;
        }
        
        // Delete the document
        await sock.sendMessage(jid, { delete: msg.key });
        console.log(`${event} document deleted silently`);
    } catch (err) {
        console.warn(`${event} delete failed (status ${Number(err.output?.statusCode || err.statusCode) || 'unknown'})`);
        return true;
    }
    
    return true;
}
