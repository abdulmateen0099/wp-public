import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'docson',
    aliases: ['docsoff'],
    description: 'Toggle document moderation in groups (ON by default)',
    usage: '.docson / .docsoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.documentModerationGroups) {
            global.documentModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'docsoff') {
            global.documentModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '🔓 *Document Moderation: OFF*\n\nDocuments/Files are now allowed in this group.\n\n💡 Use `.docson` to enable again.',
            }, { quoted: msg });
        } else {
            // docson - turn ON
            delete global.documentModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '🔒 *Document Moderation: ON*\n\nDocuments/Files will be automatically deleted (silently).\n\n💡 Use `.docsoff` to disable.',
            }, { quoted: msg });
        }
    },
};
