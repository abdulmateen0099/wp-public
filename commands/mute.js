import { requireGroupAdmin } from '../utils/groupAdmin.js';

export async function setGroupMuted(sock, msg, muted) {
    if (!await requireGroupAdmin(sock, msg)) return;
    try {
        await sock.groupSettingUpdate(msg.key.remoteJid, muted ? 'announcement' : 'not_announcement');
    } catch {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Could not change group settings. Make the bot a group admin.' });
        return;
    }
    await sock.sendMessage(msg.key.remoteJid, { text: muted
        ? ' Group muted. Only admins can send messages. Use `.unmute` to reopen it.'
        : ' Group unmuted. All members can send messages.' });
}

export default {
    name: 'mute', description: 'Allow only admins to send group messages',
    usage: '.mute', category: 'Group Admin',
    async execute(sock, msg, args) { await setGroupMuted(sock, msg, args[0]?.toLowerCase() !== 'off'); },
};
