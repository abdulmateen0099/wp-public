import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'txton',
    aliases: ['txtoff'],
    description: 'Toggle text message moderation in groups (OFF by default)',
    usage: '.txton / .txtoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.textModerationGroups) {
            global.textModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'txtoff') {
            delete global.textModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Text Message Moderation: OFF*\n\nText messages are now allowed in this group.\n\nUse .txton to enable.',
            }, { quoted: msg });
        } else {
            // txton - turn ON
            global.textModerationGroups[jid] = true;
            await sock.sendMessage(jid, {
                text: '*Text Message Moderation: ON*\n\nMembers text messages will be automatically deleted (silently).\n\nAdmin messages are ALLOWED.\n\nWarning: Only members will be restricted.\n\nUse .txtoff to disable.',
            }, { quoted: msg });
        }
    },
};
