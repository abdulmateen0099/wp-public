import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'lnk',
    description: 'Toggle anti-link protection in groups (ON by default)',
    usage: '.lnk [on/off/status]',
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
                text: '🔓 *Anti-Link: OFF*\n\nLinks are now allowed in this group.',
            }, { quoted: msg });
        } else if (action === 'status') {
            const isEnabled = global.antiLinkGroups[jid] !== false;
            await sock.sendMessage(jid, {
                text: `🔗 *Anti-Link Status*\n\nCurrent Status: ${isEnabled ? '🟢 ON (Active)' : '🔴 OFF (Disabled)'}\n\n${isEnabled ? 'Links will be automatically deleted.' : 'Links are allowed.'}\n\n_Admin messages are always excluded._`,
            }, { quoted: msg });
        } else {
            // Default is ON (remove from object or set to true)
            delete global.antiLinkGroups[jid];
            await sock.sendMessage(jid, {
                text: '🔒 *Anti-Link: ON*\n\nMessages containing links will be automatically deleted.\n\n_Admin messages are excluded._\n\n💡 *Note:* Anti-link is ON by default in all groups.',
            }, { quoted: msg });
        }
    },
};
