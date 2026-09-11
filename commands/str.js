import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { imageToSticker } from '../utils/sticker.js';

export default {
    name: 'str',
    description: 'Convert an image to a WhatsApp sticker',
    usage: '.str (send with or reply to an image)',
    category: 'Tools',

    async execute(sock, msg, args) {
        const jid = msg.key.remoteJid;

        const imageMsg = msg.message?.imageMessage ||
                         msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

        if (!imageMsg) {
            await sock.sendMessage(jid, {
                text: '*No image found!*\n\nSend an image with caption `.str` or reply to an image with `.str`',
            }, { quoted: msg });
            return;
        }

        try {

            let downloadMsg;
            if (msg.message?.imageMessage) {
                downloadMsg = msg;
            } else {
                downloadMsg = {
                    key: msg.key,
                    message: { imageMessage: imageMsg },
                };
            }

            const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {});
            const stickerBuffer = await imageToSticker(buffer);

            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
        } catch (err) {
            console.error('Sticker creation error:', err);
            await sock.sendMessage(jid, {
                text: '*Failed to create sticker.*\n\nMake sure the image is valid and try again.',
            }, { quoted: msg });
        }
    },
};
