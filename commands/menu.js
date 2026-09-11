export default {
    name: 'menu',
    description: 'Show all available commands',
    usage: '.menu',
    category: 'General',

    async execute(sock, msg, args, { commands, prefix = '.' }) {
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');

        let menuText = `*BOT COMMAND MENU*\n\n`;

        // Media Moderation Commands (Group Only)
        if (isGroup) {
            menuText += `*MEDIA MODERATION* (Default: ON)\n`;
            menuText += `${prefix}lnkon / ${prefix}lnkoff - Links\n`;
            menuText += `${prefix}stron / ${prefix}stroff - Stickers\n`;
            menuText += `${prefix}voiceon / ${prefix}voiceoff - Voice Notes\n`;
            menuText += `${prefix}picon / ${prefix}picoff - Photos\n`;
            menuText += `${prefix}vdon / ${prefix}vdoff - Videos\n`;
            menuText += `${prefix}docson / ${prefix}docsoff - Documents\n\n`;

            menuText += `*CONTENT MODERATION* (Default: OFF)\n`;
            menuText += `${prefix}txton / ${prefix}txtoff - Text Messages\n`;
            menuText += `${prefix}emjon / ${prefix}emjoff - Emojis\n\n`;

            menuText += `*DELETE RECOVERY* (Default: ON)\n`;
            menuText += `${prefix}vdton / ${prefix}vdtoff - Toggle Recovery\n`;
            menuText += `${prefix}vdt - Check Status / Manual Recovery\n\n`;

            menuText += `*GROUP ADMIN TOOLS*\n`;
            menuText += `${prefix}add [number] - Add Member\n`;
            menuText += `${prefix}kick - Remove Member (reply)\n`;
            menuText += `${prefix}remove - Remove Member (reply)\n`;
            menuText += `${prefix}mute - Mute Member (reply)\n`;
            menuText += `${prefix}unmute - Unmute Member (reply)\n`;
            menuText += `${prefix}tagall [message] - Tag All Members\n\n`;
        }

        menuText += `*GENERAL TOOLS*\n`;
        menuText += `${prefix}ping - Check Bot Response\n`;
        menuText += `${prefix}menu - Show This Menu\n`;
        menuText += `${prefix}ai [question] - Ask AI\n`;
        menuText += `${prefix}str - Image to Sticker (reply)\n\n`;

        if (isGroup) {
            menuText += `*MODERATION STATUS*\n`;
            menuText += `Links: ${global.antiLinkGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Stickers: ${global.stickerModerationGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Voice: ${global.voiceModerationGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Photos: ${global.photoModerationGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Videos: ${global.videoModerationGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Documents: ${global.documentModerationGroups?.[jid] !== false ? 'ON' : 'OFF'}\n`;
            menuText += `Text: ${global.textModerationGroups?.[jid] === true ? 'ON' : 'OFF'}\n`;
            menuText += `Emojis: ${global.emojiModerationGroups?.[jid] === true ? 'ON' : 'OFF'}\n`;
            menuText += `Recovery: ${global.deleteRecoveryGroups?.[jid] !== false ? 'ON' : 'OFF'}\n\n`;
        }

        menuText += `*BOT INFO*\n`;
        menuText += `Prefix: ${prefix}\n`;
        menuText += `Commands: ${commands.size}\n`;
        menuText += `Uptime: ${formatUptime(process.uptime())}\n\n`;

        menuText += `Note: Admin messages are exempt from most moderation.`;

        await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
    },
};

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}
