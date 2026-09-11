import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { isOwnerMessage } from './messageRouting.js';

export async function isGroupAdmin(sock, jid, identities) {
    const ids = new Set(identities.filter(Boolean).map(jidNormalizedUser));
    const metadata = await sock.groupMetadata(jid);
    // Baileys 6.7 exposes the phone identity as `jid` when `id` is a LID.
    const admins = metadata.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
    const matches = () => admins.some(p =>
        [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).some(id => ids.has(jidNormalizedUser(id)))
    );
    if (matches()) return true;
    for (const id of [...ids]) {
        if (id.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(id);
            if (pn) ids.add(jidNormalizedUser(pn));
        }
    }
    return matches();
}

export async function requireGroupAdmin(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@g.us')) {
        await sock.sendMessage(jid, { text: 'This command only works in groups.' });
        return false;
    }
    const identities = [msg.key.participant, msg.key.participantAlt, msg.key.participantPn, msg.key.senderPn];
    if (msg.key.fromMe) identities.push(sock.user?.id, sock.user?.lid);
    try {
        // Each connected account is its own owner, regardless of group role.
        const botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
        if (await isOwnerMessage(sock, msg, null, botNumber)) return true;
        if (await isGroupAdmin(sock, jid, identities)) return true;
        await sock.sendMessage(jid, { text: 'Only the bot owner or group admins can use this command.' });
    } catch {
        await sock.sendMessage(jid, { text: 'Could not check group permissions. Please try again.' });
    }
    return false;
}
