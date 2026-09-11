import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'stron',
    aliases: ['stroff'],
    description: 'Toggle sticker moderation in groups (ON by default)',
    usage: '.stron / .stroff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.stickerModerationGroups) {
            global.stickerModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'stroff') {
            global.stickerModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Sticker Moderation: OFF*\n\nStickers are now allowed in this group.\n\nUse .stron to enable again.',
            }, { quoted: msg });
        } else {
            // stron - turn ON
            delete global.stickerModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Sticker Moderation: ON*\n\nStickers will be automatically deleted (silently).\n\nUse .stroff to disable.',
            }, { quoted: msg });
        }
    },
};
