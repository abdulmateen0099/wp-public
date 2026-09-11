import { downloadContentFromMessage, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';

export const isPersonalChat = jid => /@(s\.whatsapp\.net|lid)$/.test(jid || '');

export async function senderNumber(sock, msg) {
    const candidates = [msg.key.senderPn, msg.key.remoteJidAlt, msg.key.remoteJid];
    if (!candidates.some(jid => jid?.endsWith('@s.whatsapp.net')) && msg.key.remoteJid?.endsWith('@lid')) {
        try { candidates.push(await sock.signalRepository?.lidMapping?.getPNForLID(jidNormalizedUser(msg.key.remoteJid))); } catch {}
    }
    const phone = candidates.find(jid => jid?.endsWith('@s.whatsapp.net'));
    return phone ? `+${jidNormalizedUser(phone).split('@')[0]}` : 'Number unavailable (WhatsApp did not provide a phone mapping)';
}

function payload(message) {
    let current = message, viewOnce = false;
    for (let depth = 0; current && depth < 10; depth++) {
        const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage', 'associatedChildMessage']
            .find(key => current[key]?.message);
        if (!wrapper) break;
        viewOnce ||= wrapper.startsWith('viewOnce');
        current = current[wrapper].message;
    }
    const types = [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'], ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['ptvMessage', 'video']];
    const media = types.find(([key]) => current?.[key]);
    const data = media ? current[media[0]] : null;
    return { viewOnce: viewOnce || !!data?.viewOnce, type: media?.[1], data,
        text: current?.conversation || current?.extendedTextMessage?.text || data?.caption || '' };
}

// Per-account, bounded cache. A process restart clears unsaved recovery history.
export class PersonalRecovery {
    constructor({ download = downloadContentFromMessage, maxEntries = 1000, maxBytes = 128 * 1024 * 1024, maxMediaBytes = 64 * 1024 * 1024, ttl = 86400000, now = Date.now } = {}) {
        Object.assign(this, { download, maxEntries, maxBytes, maxMediaBytes, ttl, now });
        this.entries = new Map();
        this.bytes = 0;
        this.aliases = new Map();
        this.pendingRevokes = new Set();
    }

    prune() {
        for (const [key, entry] of this.entries) {
            if (this.now() - entry.time > this.ttl || this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
                this.entries.delete(key);
                this.bytes -= entry.bytes;
                for (const [alias, canonical] of this.aliases) {
                    if (canonical === key) this.aliases.delete(alias);
                }
            }
        }
    }

    owner(sock, session) {
        const number = session?.user?.number || sock.user?.id?.split(':')[0]?.split('@')[0];
        return number ? `${number}@s.whatsapp.net` : null;
    }

    async receive(sock, msg, session) {
        if (!isPersonalChat(msg.key?.remoteJid) || msg.key.fromMe || !msg.key.id) return;
        if (normalizeMessageContent(msg.message)?.protocolMessage) return;
        this.prune();
        const aliases = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.senderPn]
            .filter(isPersonalChat).map(jid => `${jidNormalizedUser(jid)}:${msg.key.id}`);
        const number = await senderNumber(sock, msg);
        if (number.startsWith('+')) aliases.push(`${number.slice(1)}@s.whatsapp.net:${msg.key.id}`);
        const key = aliases.map(alias => this.aliases.get(alias)).find(Boolean) || aliases[0];
        for (const alias of aliases) this.aliases.set(alias, key);
        const info = payload(msg.message);
        const previous = this.entries.get(key);
        info.viewOnce ||= !!msg.key.isViewOnce || !!previous?.viewOnce;
        if (previous?.preparing || previous?.sending) {
            await (previous.sendingPromise || previous.ready);
            return this.receive(sock, msg, session);
        }
        // A placeholder may arrive first, followed by the actual View Once payload
        // under the same message ID in an upsert or messages.update event.
        if (previous && (previous.viewOnceSent ||
            (!info.viewOnce && (!info.data || previous.buffer)) ||
            (!info.data && !info.text && previous.placeholderNotified))) return;
        if (previous) this.bytes -= previous.bytes;
        const entry = { ...info, number, buffer: null, bytes: Buffer.byteLength(info.text), time: this.now(), recovered: previous?.recovered || false, preparing: true };
        if (info.viewOnce) console.log(`[view-once] id=${msg.key.id} detected type=${info.type || 'missing-media'} hasData=${!!info.data} chat=${msg.key.remoteJid}`);
        this.entries.set(key, entry);
        this.bytes += entry.bytes;
        // Publish the preparation promise before asynchronous downloads to handle fast revokes.
        entry.ready = (async () => {
            if (info.data) {
                try {
                    if (Number(info.data.fileLength) > this.maxMediaBytes) throw new Error('Media exceeds recovery size limit');
                    let data = info.data, chunks, size;
                    // For View Once, download AGGRESSIVELY with shorter timeout
                    const downloadAttempts = info.viewOnce ? 3 : 2;
                    for (let attempt = 0; attempt < downloadAttempts; attempt++) {
                        try {
                            console.log(`[view-once] id=${msg.key.id} download attempt ${attempt + 1}/${downloadAttempts}`);
                            const stream = await this.download(data, info.type);
                            chunks = [];
                            size = 0;
                            for await (const chunk of stream) {
                                size += chunk.length;
                                if (size > this.maxMediaBytes) throw new Error('Media exceeds recovery size limit');
                                chunks.push(chunk);
                            }
                            break;
                        } catch (error) {
                            const status = Number(error.response?.status || error.output?.statusCode);
                            if (attempt < downloadAttempts - 1 && [404, 410, 503].includes(status) && sock.updateMediaMessage) {
                                console.log(`[view-once] id=${msg.key.id} refreshing media (attempt ${attempt + 1})`);
                                try {
                                    const refreshed = await sock.updateMediaMessage({ ...msg, message: { [`${info.type}Message`]: data } });
                                    data = payload(refreshed.message).data;
                                    if (!data) throw error;
                                    await new Promise(r => setTimeout(r, 500)); // Brief delay before retry
                                    continue;
                                } catch (refreshError) {
                                    console.warn(`[view-once] id=${msg.key.id} refresh failed:`, refreshError.message);
                                }
                            }
                            throw error;
                        }
                    }
                    entry.buffer = Buffer.concat(chunks);
                    if (this.entries.get(key) === entry) {
                        entry.bytes += size;
                        this.bytes += size;
                    }
                    console.log(`[view-once] id=${msg.key.id} media downloaded successfully size=${size} bytes`);
                } catch (error) {
                    console.warn(`[view-once] id=${msg.key.id} download failed status=${Number(error.response?.status || error.output?.statusCode) || 'unknown'} error=${error.message}`);
                    entry.mediaError = `Media could not be saved (unavailable or larger than the ${Math.round(this.maxMediaBytes / 1024 / 1024)} MB recovery limit).`;
                }
            } else if (info.viewOnce) {
                console.log(`[view-once] id=${msg.key.id} placeholder detected, media not yet available`);
                // Placeholder - we'll wait for the actual media update
                entry.waitingForMedia = true;
            }
            // Keep only fields needed for sending; discard media download keys/metadata.
            entry.mimetype = info.data?.mimetype;
            entry.fileName = info.data?.fileName;
            entry.ptt = info.data?.ptt;
            delete entry.data;
            entry.preparing = false;
            this.prune();
        })();
        await entry.ready;
        if (info.viewOnce) {
            entry.sending = true;
            entry.sendingPromise = (async () => {
            try {
                if (entry.buffer) {
                    // Successfully downloaded media - send immediately
                    await this.send(sock, session, entry, '🔒 Saved View Once');
                    entry.viewOnceSent = true;
                    console.log(`[view-once] id=${msg.key.id} saved to self-chat`);
                } else if (entry.mediaError) {
                    // Download failed permanently - don't send error for View Once
                    // Just log it, user might not care if they don't delete it
                    console.log(`[view-once] id=${msg.key.id} download failed, waiting for potential delete`);
                    entry.downloadFailed = true;
                } else {
                    // Placeholder - don't send notification, just wait
                    console.log(`[view-once] id=${msg.key.id} placeholder only, waiting for media or delete`);
                    entry.placeholderNotified = true;
                }
            } catch (error) {
                console.warn(`[view-once] id=${msg.key.id} notification failed: ${error.message}`);
                throw error;
            } finally {
                entry.sending = false;
            }
            })();
            await entry.sendingPromise;
        }
        if (aliases.some(alias => this.pendingRevokes.has(alias))) {
            for (const alias of aliases) this.pendingRevokes.delete(alias);
            await this.recover(sock, msg.key.remoteJid, msg.key.id, session);
        }
    }

    async recover(sock, jid, id, session, { force = false } = {}) {
        if (!isPersonalChat(jid) || !id) return false;
        this.prune();
        let alias = `${jidNormalizedUser(jid)}:${id}`;
        if (!this.aliases.has(alias) && jid.endsWith('@lid')) {
            const phone = await senderNumber(sock, { key: { remoteJid: jid } });
            if (phone.startsWith('+')) alias = `${phone.slice(1)}@s.whatsapp.net:${id}`;
        }
        const entry = this.entries.get(this.aliases.get(alias) || alias);
        if (!entry) {
            console.log(`[delete-for-everyone] id=${id} not found in cache from=${jid}`);
            if (!force) {
                this.pendingRevokes.add(alias);
                if (this.pendingRevokes.size > this.maxEntries) this.pendingRevokes.delete(this.pendingRevokes.values().next().value);
            }
            return false;
        }
        if (entry.recovering || (entry.recovered && !force)) return false;
        entry.recovering = true;
        console.log(`[delete-for-everyone] id=${id} recovering from=${jid} viewOnce=${!!entry.viewOnce} hasBuffer=${!!entry.buffer} hasText=${!!entry.text} downloadFailed=${!!entry.downloadFailed}`);
        try {
            await entry.ready;
            
            // If View Once and has buffer, send the saved media!
            if (entry.viewOnce && entry.buffer && !entry.viewOnceSent) {
                console.log(`[delete-for-everyone] id=${id} View Once deleted - sending cached media!`);
                await this.send(sock, session, entry, '🔒 Saved View Once (Deleted by sender)');
                entry.recovered = true;
                entry.viewOnceSent = true;
                return true;
            }
            
            // If View Once was deleted but no media was cached
            if (entry.viewOnce && !entry.buffer) {
                console.log(`[delete-for-everyone] id=${id} View Once deleted but media not cached`);
                // Silently fail - don't notify user about deleted View Once without media
                entry.recovered = true;
                return true;
            }
            
            // Normal recovery for messages with content
            if (entry.buffer || entry.text) {
                await this.send(sock, session, entry, '🗑️ Recovered deleted message');
                entry.recovered = true;
                console.log(`[delete-for-everyone] id=${id} recovery successful`);
                return true;
            }
            
            // No content available
            console.log(`[delete-for-everyone] id=${id} no content available for recovery`);
            if (!entry.recovered) {
                this.pendingRevokes.add(alias);
                if (this.pendingRevokes.size > this.maxEntries) this.pendingRevokes.delete(this.pendingRevokes.values().next().value);
            }
            return false;
        } finally {
            entry.recovering = false;
        }
    }

    async send(sock, session, entry, title) {
        const jid = this.owner(sock, session);
        if (!jid) throw new Error('Connected account identity is unavailable');
        
        // Build caption/message text
        let caption = `${title}\n📱 From: ${entry.number}`;
        if (entry.text) caption += `\n📝 Message: ${entry.text}`;
        
        console.log(`[personal-recovery] Sending to self-chat: type=${entry.type || 'text'} from=${entry.number} hasBuffer=${!!entry.buffer}`);
        
        if (!entry.buffer) {
            // Text-only message or error notification
            await sock.sendMessage(jid, { text: caption });
        } else if (entry.type === 'audio' || entry.type === 'sticker') {
            // Audio and stickers cannot carry a normal caption: send attribution first.
            await sock.sendMessage(jid, { text: caption });
            await sock.sendMessage(jid, { [entry.type]: entry.buffer,
                ...(entry.type === 'audio' ? { mimetype: entry.mimetype || 'audio/mp4', ptt: !!entry.ptt } : {}) });
        } else {
            // Image, video, document with caption
            await sock.sendMessage(jid, { [entry.type]: entry.buffer, caption,
                ...(entry.type === 'document' ? { mimetype: entry.mimetype || 'application/octet-stream', fileName: entry.fileName || 'saved_file' } : {}) });
        }
    }
}
