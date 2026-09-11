import { userLabel } from '../utils/displayText.js';
import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'tagall',
    description: 'Tag all group members',
    usage: '.tagall [optional message]',
    category: 'Group Admin',

    async execute(sock, msg, args) {
        const jid = msg.key.remoteJid;

        if (!jid.endsWith('@g.us')) {
            await sock.sendMessage(jid, {
                text: 'This command only works in groups!',
            }, { quoted: msg });
            return;
        }

        if (!await requireGroupAdmin(sock, msg)) return;

        try {
            const metadata = await sock.groupMetadata(jid);
            const participants = metadata.participants;
            const mentions = participants.map(p => p.id);

            const customMessage = args.length > 0 ? args.join(' ') : 'Attention everyone!';

            let text = `*${customMessage}*\n\n`;
            for (const participant of participants) {
                const label = await userLabel(sock, participant.id, {
                    phoneJid: participant.jid || participant.phoneNumber,
                    name: participant.name || participant.notify,
                });
                text += `- ${label}\n`;
            }
            text += `\n_Total: ${participants.length} members_`;

            await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
        } catch (err) {
            console.error('Tagall error:', err);
            await sock.sendMessage(jid, {
                text: '*Failed to tag all members!*',
            }, { quoted: msg });
        }
    },
};
