import { isPersonalChat } from '../utils/personalRecovery.js';

export default {
    name: 'vdt',
    description: 'View delete-for-everyone recovery status and manual recovery',
    usage: '.vdt (reply to deleted message for manual recovery)',
    category: 'Tools',

    async execute(sock, msg, args, { session } = {}) {
        const jid = msg.key.remoteJid;

        // 1. Check if the user is quoting a specific message (e.g. a deleted bubble)
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId;

        if (quotedStanzaId) {
            // Manual recovery attempt
            if (isPersonalChat(jid) && session?.personalRecovery) {
                console.log(`[vdt-manual] Attempting manual recovery msgId=${quotedStanzaId} from=${jid}`);
                const success = await session.personalRecovery.recover(sock, jid, quotedStanzaId, session, { force: true });
                if (!success) {
                    await sock.sendMessage(jid, { 
                        text: '❌ *Message not found in recovery cache*\n\n' +
                              'The message may have:\n' +
                              '• Arrived while bot was offline\n' +
                              '• Expired from cache (24h limit)\n' +
                              '• Been sent before bot connection\n\n' +
                              '💡 *Automatic Recovery is Active*\n' +
                              'All new personal messages and View Once media are automatically saved.'
                    });
                }
                return;
            }
            
            // Fallback to global cache for groups (legacy)
            const storeKey = `${jid}_${quotedStanzaId}`;
            const cachedMsg = global.messageCache?.get(storeKey);
            
            if (cachedMsg) {
                const success = await global.recoverDeletedMessage(sock, jid, quotedStanzaId, session);
                
                if (!success) {
                    await sock.sendMessage(jid, { text: 'Could not extract contents from this message.' }, { quoted: msg });
                }
                return;
            } else {
                await sock.sendMessage(jid, {
                    text: '*Message not found in cache*\n\nThe bot was offline when this message was sent, or it expired from memory.',
                }, { quoted: msg });
                return;
            }
        }

        // 2. If not replying to a message, show status
        const isGroup = jid.endsWith('@g.us');
        let statusMsg;
        
        if (isGroup) {
            const recoveryEnabled = global.deleteRecoveryGroups?.[jid] !== false;
            statusMsg = `*Group Delete Recovery Status*\n\nCurrent Status: ${recoveryEnabled ? 'ON (Active)' : 'OFF (Disabled)'}\n\n${recoveryEnabled ? '*Active Features:*\nDelete for Everyone - Auto-recovered to owner\nAll message types supported\nPhotos, Videos, Documents, Voice Notes\nText messages with sender info' : '*Recovery Disabled*\nDeleted messages will NOT be recovered.'}\n\n*Control Commands:*\n.vdton - Enable delete recovery\n.vdtoff - Disable delete recovery\n\n*Manual Recovery:*\nReply to deleted message with .vdt\n\nNote: Only group admins can toggle recovery.`;
        } else {
            statusMsg = `*Personal Chat Recovery Status*\n\n*Automatic Features (Always ON):*\nView Once media - Auto-saved to "You"\nDelete for Everyone - Auto-recovered to "You"\nAll message types supported\nPersonal/private chats\n\n*Supported Media:*\nImages, Videos, Audio/Voice\nDocuments, Stickers\nText messages\n\n*Manual Recovery:*\nReply to any deleted message with .vdt\n\n*Group Recovery:*\nGroup deleted messages are also recovered (use .vdton/.vdtoff in groups).`;
        }

        await sock.sendMessage(jid, { text: statusMsg }, { quoted: msg });
    },
};
