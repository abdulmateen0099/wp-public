// libsignal hides the individual counter-gap errors behind this aggregate error.
// Keep the original error so Baileys sends its normal retry/key-bundle receipt.
export function withSignalRecovery(repository, keys, { logger, now = Date.now } = {}) {
    const failures = new Map();
    const decrypt = repository.decryptMessage.bind(repository);
    repository.decryptMessage = async input => {
        try {
            const plaintext = await decrypt(input);
            failures.delete(input.jid);
            return plaintext;
        } catch (error) {
            if (/^(No matching sessions found for message|Over 2000 messages into the future!)$/.test(error.message)) {
                const entry = failures.get(input.jid) || { count: 0, resetAt: -Infinity };
                entry.count++;
                failures.set(input.jid, entry);
                if (failures.size > 10000) failures.delete(failures.keys().next().value);
                if (entry.count >= 2 && now() - entry.resetAt >= 60000) {
                    entry.resetAt = now();
                    try {
                        const address = repository.jidToSignalProtocolAddress(input.jid);
                        // Use the socket's transactional/cacheable store, never delete files
                        // behind its cache. Account credentials and group keys stay intact.
                        await keys.set({ session: { [address]: null } });
                        logger?.warn({ jid: input.jid }, 'Reset stale sender session; awaiting WhatsApp retry with fresh keys');
                    } catch (resetError) {
                        logger?.warn({ err: resetError }, 'Could not reset stale sender session');
                    }
                }
            }
            throw error;
        }
    };
    return repository;
}
