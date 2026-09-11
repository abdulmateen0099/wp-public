import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'lnk',
    aliases: ['lnkon', 'lnkoff'],
    description: 'Toggle anti-link protection in groups (ON by default)',
    usage: '.lnkon / .lnkoff',
    category: 'Group Admin',

    async execute(sock, msg, args, context) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.antiLinkGroups) {
            global.antiLinkGroups = {};
        }

        // Check which command was used
        const fullText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const commandUsed = fullText.trim().split(/\s+/)[0].toLowerCase().replace(context?.prefix || '.', '');

        if (commandUsed === 'lnkoff') {
            global.antiLinkGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Anti-Link: OFF*\n\nLinks are now allowed in this group.\n\nUse .lnkon to enable again.',
            }, { quoted: msg });
        } else {
            // lnkon or lnk - turn ON
            delete global.antiLinkGroups[jid];
            await sock.sendMessage(jid, {
                text: '*Anti-Link: ON*\n\nMessages containing links will be automatically deleted.\n\nAdmin messages are excluded.\n\nUse .lnkoff to disable.',
            }, { quoted: msg });
        }
    },
};
