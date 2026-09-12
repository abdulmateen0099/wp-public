import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'onceon',
    aliases: ['onceoff'],
    description: 'Toggle View Once moderation in groups (ON by default)',
    usage: '.onceon / .onceoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.viewOnceModerationGroups) {
            global.viewOnceModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'onceoff') {
            global.viewOnceModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*View Once Moderation: OFF*\n\nView Once messages are now allowed in this group.\n\nUse .onceon to enable again.',
            }, { quoted: msg });
        } else {
            // onceon - turn ON (or confirm it's ON)
            delete global.viewOnceModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*View Once Moderation: ON*\n\nView Once messages will be automatically deleted (silently).\n\nAll View Once media types are blocked (photos, videos, voice notes, etc).\n\nAdmin messages are ALLOWED.\n\nUse .onceoff to disable.',
            }, { quoted: msg });
        }
    },
};
