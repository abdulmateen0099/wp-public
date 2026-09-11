import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { isOwnerMessage } from '../utils/messageRouting.js';

const running = new Set();
const identities = participant => [participant.id, participant.jid, participant.lid, participant.phoneNumber]
    .filter(Boolean).map(jidNormalizedUser);

export default {
    name: 'remove',
    description: 'Remove all other removable group members (bot must be admin)',
    usage: '.remove',
    category: 'Group Admin',

    async execute(sock, msg) {
        const number = sock.user?.id?.split(':')[0]?.split('@')[0];
        if (!number || !await isOwnerMessage(sock, msg, null, number)) return;
        const ownerJid = `${number}@s.whatsapp.net`;
        const reply = text => sock.sendMessage(ownerJid, { text });
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) return reply('This command only works in groups.');
        const runKey = `${ownerJid}:${jid}`;
        if (running.has(runKey)) return reply('Member removal is already running for this group.');
        running.add(runKey);
        let removed = 0, attempted = 0;
        try {
            const self = new Set([sock.user?.id, sock.user?.lid,
                sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid,
                msg.key.participant, msg.key.participantAlt, msg.key.participantPn, msg.key.senderPn]
                .filter(Boolean).map(jidNormalizedUser));
            const metadata = await sock.groupMetadata(jid);
            // Resolve phone mappings before selecting targets so the bot is never removed.
            const members = [];
            for (const participant of metadata.participants) {
                const ids = identities(participant);
                if (participant.id?.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
                    const pn = await sock.signalRepository.lidMapping.getPNForLID(participant.id);
                    if (pn) ids.push(jidNormalizedUser(pn));
                }
                members.push({ participant, ids, isSelf: ids.some(id => self.has(id)) });
            }
            if (!members.some(m => m.isSelf && ['admin', 'superadmin'].includes(m.participant.admin))) {
                return await reply('Cannot remove members: the connected bot account must be a group admin. Ask an existing admin to promote it.');
            }
            const creator = metadata.owner ? jidNormalizedUser(metadata.owner) : null;
            const targets = [...new Set(members.filter(m => !m.isSelf &&
                m.participant.admin !== 'superadmin' && !m.ids.includes(creator))
                .map(m => m.participant.id).filter(Boolean))];
            if (!targets.length) return await reply('No removable members. Your account and the group creator are kept.');
            for (let i = 0; i < targets.length; i += 10) {
                const batch = targets.slice(i, i + 10);
                attempted += batch.length;
                const results = await sock.groupParticipantsUpdate(jid, batch, 'remove');
                removed += batch.filter(target => results?.some(result =>
                    jidNormalizedUser(result.jid || '') === jidNormalizedUser(target) && String(result.status) === '200'
                )).length;
                // Do not keep issuing removals after WhatsApp reports failure or unknown status.
                if (!batch.every(target => results?.some(result =>
                    jidNormalizedUser(result.jid || '') === jidNormalizedUser(target) && String(result.status) === '200'
                ))) break;
            }
            await reply(`Group: ${metadata.subject || jid}\nConfirmed removed: ${removed} of ${targets.length}.\nUnconfirmed attempts: ${attempted - removed}. Not attempted: ${targets.length - attempted}.\nYour account and the group creator are kept.`);
        } catch {
            await reply(`Removal stopped. Confirmed removed: ${removed}. Unconfirmed attempts: ${attempted - removed}. Check group membership and bot permissions before retrying.`);
        } finally {
            running.delete(runKey);
        }
    },
};
