import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'add', description: 'Add a member by international phone number',
    usage: '.add <country-code + number>', category: 'Group Admin',
    async execute(sock, msg, args) {
        if (!await requireGroupAdmin(sock, msg)) return;
        const jid = msg.key.remoteJid;
        const number = args.join('').replace(/[+\s()-]/g, '');
        if (!/^[1-9]\d{6,14}$/.test(number)) {
            await sock.sendMessage(jid, { text: 'Usage: `.add 923001234567` (include country code).' });
            return;
        }
        let status;
        try {
            const results = await sock.groupParticipantsUpdate(jid, [`${number}@s.whatsapp.net`], 'add');
            status = String(results?.[0]?.status || 'unknown');
        } catch {
            await sock.sendMessage(jid, { text: 'Could not add this member. Make the bot a group admin and check the number and member’s privacy settings.' });
            return;
        }
        const messages = {
            '200': ` Added +${number} to the group.`,
            '403': ' WhatsApp did not allow the addition. Check the bot’s admin permission and the member’s privacy settings; they may need an invite link.',
            '409': ' This person is already in the group.',
            '404': ' This WhatsApp account could not be found.',
            '408': ' This person recently left; WhatsApp may require an invite link.',
        };
        await sock.sendMessage(jid, { text: messages[status] || ` Member was not added (WhatsApp status: ${status}).` });
    },
};
