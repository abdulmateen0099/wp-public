import { askGemini } from '../utils/gemini.js';

export default {
    name: 'ai', description: 'Ask Gemini a question',
    usage: '.ai <your question>', category: 'AI',
    async execute(sock, msg, args) {
        const jid = msg.key.remoteJid;
        const question = args.join(' ').trim();
        if (!question) {
            await sock.sendMessage(jid, { text: 'Usage: `.ai What is Node.js?`' });
            return;
        }
        let answer;
        try { answer = await askGemini(question); }
        catch (err) {
            await sock.sendMessage(jid, { text: `${err.message}` });
            return;
        }
        for (let offset = 0; offset < answer.length; offset += 3500) {
            await sock.sendMessage(jid, { text: `${offset ? '' : ' *Gemini*\n\n'}${answer.slice(offset, offset + 3500)}` });
        }
    },
};
