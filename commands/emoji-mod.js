import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'emjon',
    aliases: ['emjoff'],
    description: 'Toggle emoji moderation in groups (OFF by default)',
    usage: '.emjon / .emjoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.emojiModerationGroups) {
            global.emojiModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'emjoff') {
            delete global.emojiModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Emoji Moderation: OFF*\n\nEmojis are now allowed in messages.\n\nUse .emjon to enable.',
            }, { quoted: msg });
        } else {
            // emjon - turn ON
            global.emojiModerationGroups[jid] = true;
            await sock.sendMessage(jid, {
                text: '*Emoji Moderation: ON*\n\nMessages containing emojis will be automatically deleted (silently).\n\nAdmin messages are ALLOWED.\n\nWarning: Members cannot use emojis in text messages.\n\nUse .emjoff to disable.',
            }, { quoted: msg });
        }
    },
};
