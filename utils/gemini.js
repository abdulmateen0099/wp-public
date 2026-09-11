import axios from 'axios';

export async function askGemini(question, {
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    fallbackModel = process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.5-flash-lite',
    post = axios.post,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    if (!apiKey?.trim()) throw new Error('Set GEMINI_API_KEY in Railway Variables to enable .ai.');
    let data;
    const models = [model, model];
    if (fallbackModel && fallbackModel !== model) models.push(fallbackModel);
    const deadline = Date.now() + 30000;
    try {
        for (let attempt = 0; attempt < models.length; attempt++) {
            try {
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw Object.assign(new Error('Request deadline reached'), { code: 'ETIMEDOUT' });
                ({ data } = await post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(models[attempt])}:generateContent`,
                    {
                        systemInstruction: { parts: [{ text: 'You are a helpful WhatsApp assistant. Keep answers concise, under 500 words. Use plain, clean text without emojis or decorative symbols. Use *bold* only for short headings when useful.' }] },
                        contents: [{ role: 'user', parts: [{ text: question }] }],
                        generationConfig: { maxOutputTokens: 2048 },
                    },
                    { headers: { 'x-goog-api-key': apiKey.trim(), 'Content-Type': 'application/json' }, timeout: remaining },
                ));
                break;
            } catch (err) {
                const status = err.response?.status;
                const transient = [500, 502, 503, 504].includes(status) ||
                    ['ECONNRESET', 'EAI_AGAIN', 'ECONNABORTED', 'ETIMEDOUT'].includes(err.code);
                // Log only safe diagnostics, never the error object or request headers.
                console.warn(`Gemini attempt ${attempt + 1} failed (HTTP ${Number(status) || 'none'}).`);
                const delay = 750 * (2 ** attempt);
                if (!transient || attempt === models.length - 1 || Date.now() + delay >= deadline) throw err;
                await sleep(delay);
            }
        }
    } catch (err) {
        // Axios errors contain credentials in their config: expose only safe messages.
        const status = err.response?.status;
        if ([400, 401, 403].includes(status)) throw new Error('Gemini rejected the request. Check GEMINI_API_KEY and its API permissions in Railway.');
        if (status === 429) throw new Error('Gemini quota or rate limit reached. Check your API quota, then try again.');
        if (status === 404) throw new Error('Gemini model unavailable. Check GEMINI_MODEL in Railway.');
        if ([500, 502, 503, 504].includes(status)) throw new Error('Gemini is temporarily busy (Google service error). Automatic retries failed; please try again shortly.');
        if (['ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) throw new Error('Railway could not resolve Google’s API address. Please try again shortly.');
        if (['ECONNABORTED', 'ETIMEDOUT'].includes(err.code)) throw new Error('Gemini timed out. Please try again.');
        throw new Error('Gemini is currently unreachable. Please try again later.');
    }
    const candidate = data?.candidates?.[0];
    if (data?.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(candidate?.finishReason)) {
        throw new Error('Gemini could not answer this request. Try rephrasing your question.');
    }
    const answer = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
    if (!answer) throw new Error('Gemini returned no text. Please try another question.');
    return answer;
}
