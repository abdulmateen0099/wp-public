import { setGroupMuted } from './mute.js';

export default {
    name: 'unmute', description: 'Allow all members to send group messages',
    usage: '.unmute', category: 'Group Admin',
    async execute(sock, msg) { await setGroupMuted(sock, msg, false); },
};
