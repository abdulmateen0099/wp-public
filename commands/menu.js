export default {
    name: 'menu',
    description: 'Show all available commands',
    usage: '.menu',
    category: 'General',

    async execute(sock, msg, args, { commands, prefix = '.' }) {
        const categories = {};

        for (const cmd of commands.values()) {
            const cat = cmd.category || 'Uncategorized';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(cmd);
        }

        let menuText = '*Command Menu*\n\n';

        for (const [category, commands] of Object.entries(categories)) {
            menuText += `*${category}*\n`;
            for (const cmd of commands) {
                menuText += `- \`${cmd.usage.replace(/^\./, prefix)}\`: ${cmd.description}\n`;
            }
            menuText += `\n`;
        }

        menuText += `Prefix: ${prefix}\n`;
        menuText += `Uptime: ${formatUptime(process.uptime())}\n`;

        await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
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
