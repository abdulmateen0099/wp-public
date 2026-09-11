import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'vdon',
    aliases: ['vdoff'],
    description: 'Toggle video moderation in groups (ON by default)',
    usage: '.vdon / .vdoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.videoModerationGroups) {
            global.videoModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'vdoff') {
            global.videoModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Video Moderation: OFF*\n\nVideos are now allowed in this group.\n\nUse .vdon to enable again.',
            }, { quoted: msg });
        } else {
            // vdon - turn ON
            delete global.videoModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Video Moderation: ON*\n\nVideos will be automatically deleted (silently).\n\nUse .vdoff to disable.',
            }, { quoted: msg });
        }
    },
};
