import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'vdton',
    aliases: ['vdtoff'],
    description: 'Toggle delete recovery in groups (ON by default)',
    usage: '.vdton / .vdtoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.deleteRecoveryGroups) {
            global.deleteRecoveryGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'vdtoff') {
            global.deleteRecoveryGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '🔓 *Delete Recovery: OFF*\n\nDeleted messages will NOT be recovered in this group.\n\n💡 Use `.vdton` to enable again.',
            }, { quoted: msg });
        } else {
            // vdton - turn ON
            delete global.deleteRecoveryGroups[jid];
            await sock.sendMessage(jid, {
                text: '🔒 *Delete Recovery: ON*\n\nDeleted messages will be forwarded to your personal chat.\n\n💡 Use `.vdtoff` to disable.',
            }, { quoted: msg });
        }
    },
};
