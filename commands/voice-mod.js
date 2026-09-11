import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'voiceon',
    aliases: ['voiceoff'],
    description: 'Toggle voice note moderation in groups (ON by default)',
    usage: '.voiceon / .voiceoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.voiceModerationGroups) {
            global.voiceModerationGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'voiceoff') {
            global.voiceModerationGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Voice Note Moderation: OFF*\n\nVoice notes are now allowed in this group.\n\nUse .voiceon to enable again.',
            }, { quoted: msg });
        } else {
            // voiceon - turn ON
            delete global.voiceModerationGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Voice Note Moderation: ON*\n\nVoice notes will be automatically deleted (silently).\n\nUse .voiceoff to disable.',
            }, { quoted: msg });
        }
    },
};
