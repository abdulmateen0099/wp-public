import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';

export function normalizeIncomingMessage(msg) {
    return { ...msg, message: normalizeMessageContent(msg.message) };
}

export function shouldHandleUpsert(msg, type, listeningSince) {
    if (type === 'notify') return true;
    // Offline delivery also uses append. Never execute historical commands on login.
    const timestamp = Number(msg.messageTimestamp) * 1000;
    return type === 'append' && Number.isFinite(timestamp) && timestamp >= listeningSince;
}

export async function isOwnerMessage(sock, msg, ownerNumber, botNumber) {
    if (msg.key.fromMe) return true;
    const group = msg.key.remoteJid?.endsWith('@g.us');
    const sender = group ? msg.key.participant : msg.key.remoteJid;
    const alternate = group ? msg.key.participantAlt : msg.key.remoteJidAlt;
    // Baileys 6 uses senderPn/participantPn; newer versions use *Alt fields.
    const phone = group ? (msg.key.participantPn || msg.key.senderPn) : msg.key.senderPn;
    const identities = new Set([sender, alternate, phone].filter(Boolean).map(jidNormalizedUser));
    if (sender?.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
        const phoneJid = await sock.signalRepository.lidMapping.getPNForLID(sender);
        if (phoneJid) identities.add(jidNormalizedUser(phoneJid));
    }
    return [ownerNumber, botNumber].filter(Boolean)
        .some(number => identities.has(`${number}@s.whatsapp.net`));
}

export function rememberMessage(seen, key, limit = 10000) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value);
    return true;
}
