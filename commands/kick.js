import { requireGroupAdmin } from '../utils/groupAdmin.js';

export default {
    name: 'kick',
    description: 'Remove a member from the group',
    usage: '.kick @user',
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

        // Removed fragile bot admin check. Just attempt and catch the error.

        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;

        const targets = [...mentioned];
        if (quoted && !targets.includes(quoted)) {
            targets.push(quoted);
        }

        if (targets.length === 0) {
            await sock.sendMessage(jid, {
                text: '*Please mention or reply to the user you want to kick!*\n\nUsage: `.kick @user`',
            }, { quoted: msg });
            return;
        }

        try {
            const results = await sock.groupParticipantsUpdate(jid, targets, 'remove');
            const removed = targets.filter(target => results?.some(result =>
                result.jid === target && String(result.status) === '200'
            )).length;
            await sock.sendMessage(jid, {
                text: removed === targets.length
                    ? `*Removed ${removed} member(s) from the group.*`
                    : `Removed ${removed} of ${targets.length} member(s). WhatsApp did not confirm the remaining removals. Make the bot a group admin and check the target members.`,
            }, { quoted: msg });
        } catch (err) {
            console.error('Kick error:', err);
            await sock.sendMessage(jid, {
                text: '*Failed to remove member!*\n\nMake the bot a group admin and check the target member’s permissions.',
            }, { quoted: msg });
        }
    },
};
