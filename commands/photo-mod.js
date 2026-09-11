import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'picon',
    aliases: ['picoff'],
    description: 'Toggle photo moderation in groups (ON by default)',
    usage: '.picon / .picoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.photoModerationGroups) {
            global.photoModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'picoff') {
            global.photoModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Photo Moderation: OFF*\n\nPhotos/Images are now allowed in this group.\n\nUse .picon to enable again.',
            }, { quoted: msg });
        } else {
            // picon - turn ON
            delete global.photoModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Photo Moderation: ON*\n\nPhotos/Images will be automatically deleted (silently).\n\nUse .picoff to disable.',
            }, { quoted: msg });
        }
    },
};
