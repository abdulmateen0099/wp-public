import { jidNormalizedUser } from '@whiskeysockets/baileys';

export function cleanDisplayText(value) {
    return value
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u20E3]/gu, '')
        .replace(/@?[\w.:-]+@lid\b/gi, 'Member')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

export function cleanOutgoingContent(content) {
    if (!content || typeof content !== 'object') return content;
    const result = { ...content };
    for (const field of ['text', 'caption']) {
        if (typeof result[field] === 'string') result[field] = cleanDisplayText(result[field]);
    }
    return result;
}

export async function userLabel(sock, jid, { phoneJid, name } = {}) {
    if (name?.trim()) return cleanDisplayText(name) || 'Member';
    const phone = [phoneJid, jid].find(id => id?.endsWith('@s.whatsapp.net'));
    if (phone) return '@' + jidNormalizedUser(phone).split('@')[0];
    if (jid?.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const mapped = await sock.signalRepository.lidMapping.getPNForLID(jidNormalizedUser(jid));
            if (mapped?.endsWith('@s.whatsapp.net')) return '@' + jidNormalizedUser(mapped).split('@')[0];
        } catch { /* Missing mapping must not prevent the reply. */ }
    }
    return 'Member';
}
