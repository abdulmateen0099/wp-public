import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'lnk',
    description: 'Toggle anti-link protection in groups',
    usage: '.lnk [on/off]',
    category: 'Group Admin',

    async execute(sock, msg, args) {
        const jid = msg.key.remoteJid;

        if (!await requireGroupAdmin(sock, msg)) return;

        if (!global.antiLinkGroups) {
            global.antiLinkGroups = {};
        }

        const action = args[0]?.toLowerCase();

        if (action === 'off') {
            global.antiLinkGroups[jid] = false;
            await sock.sendMessage(jid, {
                text: '*Anti-Link: OFF*\n\nLinks are now allowed in this group.',
            }, { quoted: msg });
        } else {
            global.antiLinkGroups[jid] = true;
            await sock.sendMessage(jid, {
                text: '*Anti-Link: ON*\n\nMessages containing links will be automatically deleted.\n\n_Admin messages are excluded._',
            }, { quoted: msg });
        }
    },
};
