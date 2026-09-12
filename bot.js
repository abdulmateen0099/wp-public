/**
 * ╔══════════════════════════════════════════╗
 * ║     WhatsApp Automation Bot v1.0.0       ║
 * ║     Powered by Baileys + Node.js         ║
 * ╚══════════════════════════════════════════╝
 */
import 'dotenv/config';
import express from 'express';

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Prevent the server from crashing due to Baileys decryption errors (like Bad MAC)
});
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    proto,
    WAMessageStubType,
    downloadContentFromMessage,
} from '@whiskeysockets/baileys';

import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import crypto from 'crypto';

import MessageStore from './utils/messageStore.js';
import { cleanDisplayText, cleanOutgoingContent, userLabel } from './utils/displayText.js';
import { moderateGroupSticker } from './utils/stickerModeration.js';
import { moderateGroupVoice } from './utils/voiceModeration.js';
import { moderateGroupPhoto } from './utils/photoModeration.js';
import { moderateGroupVideo } from './utils/videoModeration.js';
import { moderateGroupDocument } from './utils/documentModeration.js';
import { moderateGroupText } from './utils/textModeration.js';
import { moderateGroupEmoji } from './utils/emojiModeration.js';
import { moderateGroupViewOnce } from './utils/viewOnceModeration.js';
import { normalizeIncomingMessage, shouldHandleUpsert, isOwnerMessage, rememberMessage } from './utils/messageRouting.js';
import { cleanOldDownloads } from './utils/media.js';
import { resolveAuthDirectory } from './utils/authStorage.js';
import { PersonalRecovery, isPersonalChat } from './utils/personalRecovery.js';

// ─── ESM __dirname polyfill ──────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────
const PREFIX = process.env.PREFIX || '.';
// OWNER_NUMBER is intentionally NOT used — every connected account is
// automatically its own owner (dynamic multi-account). Commands only
// respond to messages sent fromMe (the bot's own number), so no
// hardcoded phone number is needed. Connect any number and it works.
const AUTO_REPLY = process.env.AUTO_REPLY !== 'false';
const PORT = process.env.PORT || 3000;
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'abdul';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'abdul@332211';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

// ─── Multi-Session State & Management ─────────────────────
const authBaseDir = resolveAuthDirectory(__dirname);
const sessionsBaseDir = path.join(authBaseDir, 'sessions');
if (!fs.existsSync(sessionsBaseDir)) {
    fs.mkdirSync(sessionsBaseDir, { recursive: true });
}

class WhatsAppSession {
    constructor(id, name = 'WhatsApp Account') {
        this.id = id;
        this.name = name;
        this.sock = null;
        this.mode = 'restore';
        this.state = 'idle'; // 'idle' | 'starting' | 'pairing_code' | 'qr' | 'connected' | 'disconnected'
        this.pairingCode = null;
        this.qrDataUrl = null;
        this.user = null; // { name, id, number }
        this.startTime = Date.now();
        this.listeningSince = Math.floor(Date.now() / 1000) * 1000;
        this.processedMessages = new Set();
        this.retryMessages = new MessageStore(10000);
        this.personalRecovery = new PersonalRecovery();
        this.generation = 0;
        this.reconnectTimer = null;
        this.pairingTimer = null;
        this.lastMessageAt = null;
        this.disconnectMessage = null;
        this.authDir = path.join(sessionsBaseDir, id);
        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }
    }

    clearAuth() {
        this.personalRecovery = new PersonalRecovery();
        if (fs.existsSync(this.authDir)) {
            try {
                const files = fs.readdirSync(this.authDir);
                for (const f of files) {
                    fs.rmSync(path.join(this.authDir, f), { recursive: true, force: true });
                }
                console.log(`Auth cleared for session ${this.id}`);
            } catch (err) {
                console.error(`Error clearing auth for session ${this.id}:`, err.message);
            }
        }
    }

    async cleanup() {
        const generation = ++this.generation;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.pairingTimer);
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(new Error('Session stopped'));
            } catch (_) {}
            this.sock = null;
        }
        return generation;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.user?.name || this.name,
            number: this.user?.number || null,
            state: this.state,
            pairingCode: this.pairingCode,
            qrDataUrl: this.qrDataUrl,
            user: this.user,
            prefix: PREFIX,
            commandsCount: commands.size,
            lastMessageAt: this.lastMessageAt,
            disconnectMessage: this.disconnectMessage,
            uptime: this.state === 'connected' ? Math.floor((Date.now() - this.startTime) / 1000) : 0
        };
    }
}

const activeSessions = new Map();

function getPrimarySession() {
    if (activeSessions.size === 0) {
        const primary = new WhatsAppSession('primary', 'Primary Account');
        activeSessions.set('primary', primary);
        return primary;
    }
    return activeSessions.get('primary') || activeSessions.values().next().value;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Dashboard Authentication & Protection ────────────────
function generateToken(user) {
    const timestamp = Date.now();
    const hash = crypto.createHmac('sha256', AUTH_SECRET).update(`${user}:${timestamp}`).digest('hex');
    return `${timestamp}.${hash}`;
}

function verifyToken(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [timestamp, hash] = parts;
    const now = Date.now();
    // 7 days token expiration
    if (now - parseInt(timestamp, 10) > 7 * 24 * 60 * 60 * 1000) return false;
    const expectedHash = crypto.createHmac('sha256', AUTH_SECRET).update(`${DASHBOARD_USER}:${timestamp}`).digest('hex');
    return hash === expectedHash;
}

// Open auth endpoints
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
        const token = generateToken(username);
        console.log(`Dashboard login successful for user '${username}'`);
        return res.json({ success: true, token, user: username });
    }
    console.warn(`Failed dashboard login attempt for user '${username}'`);
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
});

app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
    const token = authHeader?.replace('Bearer ', '').trim();
    if (verifyToken(token)) {
        return res.json({ authenticated: true, user: DASHBOARD_USER });
    }
    return res.status(401).json({ authenticated: false });
});

// Protect all other /api endpoints
app.use('/api', (req, res, next) => {
    if (req.path === '/auth/login' || req.path === '/auth/verify') {
        return next();
    }
    const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
    const token = authHeader?.replace('Bearer ', '').trim();
    if (verifyToken(token)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized', requireLogin: true });
});

// ─── Multi-Session API Endpoints ──────────────────────────

// List all sessions
app.get('/api/sessions', (req, res) => {
    const list = Array.from(activeSessions.values()).map(s => s.toJSON());
    res.json({ sessions: list });
});

// Create a new session slot (reuses existing idle if available)
app.post('/api/sessions/create', (req, res) => {
    try {
        // Reuse an existing idle account if one is already waiting for login
        const existingIdle = Array.from(activeSessions.values()).find(s => s.state === 'idle' && !s.user && s.id !== 'primary');
        if (existingIdle) {
            console.log(`Reusing existing idle session: ${existingIdle.id}`);
            return res.json({ success: true, session: existingIdle.toJSON(), reused: true });
        }

        const count = activeSessions.size + 1;
        const id = `account_${Date.now().toString(36)}`;
        const name = req.body.name || `Account ${count}`;
        const session = new WhatsAppSession(id, name);
        activeSessions.set(id, session);
        console.log(`Created new session slot: ${id} (${name})`);
        res.json({ success: true, session: session.toJSON() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get specific session status
app.get('/api/sessions/:id/status', (req, res) => {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
});

// Pairing code on specific session
async function pairingCodeHandler(req, res) {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
    if (cleanNumber.length < 8) return res.status(400).json({ success: false, error: 'Please enter a valid phone number with country code.' });

    try {
        console.log(`\n [${session.id}] Starting pairing code login for: ${cleanNumber}`);
        session.state = 'starting';
        session.pairingCode = null;
        session.qrDataUrl = null;

        await startSession(session, { mode: 'pairing', phoneNumber: cleanNumber });

        let wait = 0;
        while (!session.pairingCode && wait < 30 && session.state !== 'connected' && session.state !== 'idle') {
            await new Promise(r => setTimeout(r, 500));
            wait++;
        }

        if (session.pairingCode) {
            return res.json({ success: true, pairingCode: session.pairingCode });
        } else if (session.state === 'connected') {
            return res.json({ success: true, connected: true });
        } else {
            return res.status(500).json({ success: false, error: 'Timeout waiting for WhatsApp pairing code.' });
        }
    } catch (err) {
        session.state = 'idle';
        res.status(500).json({ success: false, error: err.message });
    }
}
app.post('/api/sessions/:id/auth/pairing-code', pairingCodeHandler);

// Start QR on specific session
async function startQrHandler(req, res) {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    try {
        console.log(`\n [${session.id}] Starting QR code login flow...`);
        session.state = 'starting';
        session.pairingCode = null;
        session.qrDataUrl = null;

        await startSession(session, { mode: 'qr' });

        let wait = 0;
        while (!session.qrDataUrl && wait < 30 && session.state !== 'connected' && session.state !== 'idle') {
            await new Promise(r => setTimeout(r, 500));
            wait++;
        }

        if (session.qrDataUrl) {
            return res.json({ success: true, qrDataUrl: session.qrDataUrl });
        } else if (session.state === 'connected') {
            return res.json({ success: true, connected: true });
        } else {
            return res.status(500).json({ success: false, error: 'Timeout generating QR code.' });
        }
    } catch (err) {
        session.state = 'idle';
        res.status(500).json({ success: false, error: err.message });
    }
}
app.post('/api/sessions/:id/auth/start-qr', startQrHandler);

// Cancel auth on specific session
async function cancelAuthHandler(req, res) {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    try {
        await session.cleanup();
        session.clearAuth();
        session.state = 'idle';
        session.pairingCode = null;
        session.qrDataUrl = null;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
app.post('/api/sessions/:id/auth/cancel', cancelAuthHandler);

// Logout specific session
async function logoutHandler(req, res) {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    try {
        console.log(`[${session.id}] Logout requested...`);
        if (session.sock) {
            session.sock.ev.removeAllListeners();
            try { await session.sock.logout(); } catch (_) {
                try { session.sock.end(new Error('Manual logout')); } catch (_2) {}
            }
        }
        await session.cleanup();
        session.clearAuth();

        if (session.id !== 'primary') {
            try { fs.rmSync(session.authDir, { recursive: true, force: true }); } catch (_) {}
            activeSessions.delete(session.id);
        } else {
            session.state = 'idle';
            session.user = null;
            session.pairingCode = null;
            session.qrDataUrl = null;
        }

        res.json({ success: true, message: `Session ${session.id} logged out successfully` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
app.post('/api/sessions/:id/logout', logoutHandler);

// Delete specific session (HTTP DELETE or POST)
async function deleteSessionHandler(req, res) {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    try {
        console.log(`Deleting session: ${session.id}...`);
        if (session.sock) {
            session.sock.ev.removeAllListeners();
            try { await session.sock.logout(); } catch (_) {
                try { session.sock.end(new Error('Manual delete')); } catch (_2) {}
            }
        }
        await session.cleanup();
        session.clearAuth();

        if (session.id !== 'primary') {
            try { fs.rmSync(session.authDir, { recursive: true, force: true }); } catch (_) {}
            activeSessions.delete(session.id);
        } else {
            session.state = 'idle';
            session.user = null;
            session.pairingCode = null;
            session.qrDataUrl = null;
        }

        res.json({ success: true, message: `Session ${session.id} deleted successfully` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
app.delete('/api/sessions/:id', deleteSessionHandler);
app.post('/api/sessions/:id/delete', deleteSessionHandler);

// Clear all inactive/idle sessions (except connected accounts & primary)
app.post('/api/sessions/clear-inactive', async (req, res) => {
    try {
        let deleted = 0;
        for (const [id, session] of activeSessions.entries()) {
            if (id !== 'primary' && session.state !== 'connected') {
                await session.cleanup();
                session.clearAuth();
                try { fs.rmSync(session.authDir, { recursive: true, force: true }); } catch (_) {}
                activeSessions.delete(id);
                deleted++;
            }
        }
        console.log(`Cleaned up ${deleted} inactive session(s).`);
        res.json({ success: true, deletedCount: deleted });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Backward Compatible Endpoints (Primary Session) ──────
app.get('/api/status', (req, res) => {
    const primary = getPrimarySession();
    res.json(primary.toJSON());
});

app.post('/api/auth/pairing-code', (req, res) => {
    req.params.id = getPrimarySession().id;
    return pairingCodeHandler(req, res);
});

app.post('/api/auth/start-qr', (req, res) => {
    req.params.id = getPrimarySession().id;
    return startQrHandler(req, res);
});

app.post('/api/auth/cancel', (req, res) => {
    req.params.id = getPrimarySession().id;
    return cancelAuthHandler(req, res);
});

app.post('/api/logout', (req, res) => {
    req.params.id = getPrimarySession().id;
    return logoutHandler(req, res);
});

// ─── In-Memory Terminal Log Stream ────────────────────────
const terminalLogs = [];
function addTerminalLog(type, text) {
    if (!text || typeof text !== 'string') return;
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    terminalLogs.push({
        id: Date.now() + Math.random(),
        time: timeStr,
        type, // 'info' | 'warn' | 'error' | 'command' | 'success'
        text: cleanDisplayText(text)
    });
    if (terminalLogs.length > 300) {
        terminalLogs.shift();
    }
}

// Hook console.log & console.error
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origConsoleWarn = console.warn;

console.log = (...args) => {
    origConsoleLog(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.trim()) addTerminalLog('info', msg);
};

console.error = (...args) => {
    origConsoleError(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.trim()) addTerminalLog('error', msg);
};

console.warn = (...args) => {
    origConsoleWarn(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.trim()) addTerminalLog('warn', msg);
};

// ─── API: Terminal Logs & Execution ──────────────────────
app.get('/api/terminal/logs', (req, res) => {
    res.json({ logs: terminalLogs });
});

app.post('/api/terminal/execute', async (req, res) => {
    const session = getPrimarySession();
    const botStatus = session.toJSON();
    const { command } = req.body;
    if (!command || !command.trim()) {
        return res.status(400).json({ error: 'Command is required' });
    }

    const trimmed = command.trim();
    addTerminalLog('command', `$ ${trimmed}`);
    const lower = trimmed.toLowerCase();

    if (lower === 'clear') {
        return res.json({ clear: true });
    }

    if (lower === 'help') {
        return res.json({
            output: [
                'WhatsApp Bot Terminal [Version 1.0.0]',
                'Available Terminal Commands:',
                '  help                 Show this help manual',
                '  status               View bot connection status and memory',
                '  uptime               View container uptime',
                '  commands             List all available bot commands',
                '  clear                Clear the terminal display',
                '  .ping                Test bot response latency',
                '  .menu                Show list of all WhatsApp bot tools',
                '  .ai <question>       Ask a question to AI',
                '  logout               Log out from WhatsApp account'
            ].join('\n')
        });
    }

    if (lower === 'status') {
        const mem = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
        return res.json({
            output: [
                `State: ${botStatus.state.toUpperCase()}`,
                `User: ${botStatus.user?.name || 'None'} (+${botStatus.user?.number || 'Not connected'})`,
                `Prefix: ${botStatus.prefix}`,
                `Commands: ${commands.size} active`,
                `Uptime: ${Math.floor(process.uptime())}s`,
                `Memory RSS: ${mem} MB`
            ].join('\n')
        });
    }

    if (lower === 'uptime') {
        return res.json({
            output: `Bot Uptime: ${Math.floor(process.uptime())} seconds`
        });
    }

    if (lower === 'commands') {
        const list = Array.from(commands.values()).map(c => `  .${c.name.padEnd(12)} - ${c.description || ''}`);
        return res.json({
            output: `Registered WhatsApp Commands (${commands.size}):\n` + list.join('\n')
        });
    }

    if (lower === 'logout') {
        const sock = session.sock;
        sock?.ev.removeAllListeners();
        try { await sock?.logout(); } catch (_) {}
        await session.cleanup();
        session.clearAuth();
        session.state = 'idle';
        session.user = null;
        session.qrDataUrl = null;
        session.pairingCode = null;
        return res.json({
            output: 'Logged out successfully from WhatsApp. Returned to idle login screen.'
        });
    }

    if (lower === 'node bot.js' || lower === 'npm start' || lower === 'node bot') {
        return res.json({
            output: ` The WhatsApp bot server is ALREADY running and active (PID ${process.pid})!\n` +
                    `Current Connection State: ${botStatus.state.toUpperCase()}\n` +
                    (botStatus.state === 'idle' 
                        ? ' To link your account: Enter your phone number in the card above or click "Scan with QR Code"!'
                        : ` Connected as: ${botStatus.user?.name || 'User'} (+${botStatus.user?.number})`)
        });
    }

    if (lower === 'scan' || lower === 'qr') {
        try {
            await startBot({ mode: 'qr' });
            return res.json({ output: ' Starting QR mode... QR Code is now generated on the screen above!' });
        } catch (err) {
            return res.json({ output: `Failed to start QR: ${err.message}` });
        }
    }

    if (trimmed.startsWith(PREFIX)) {
        const cmdName = trimmed.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
        const cmd = commands.get(cmdName);
        if (cmd) {
            return res.json({
                output: `[COMMAND: ${PREFIX}${cmdName}]\nCategory: ${cmd.category || 'General'}\nUsage: ${cmd.usage || 'N/A'}\nDescription: ${cmd.description || 'N/A'}\n\nSend this command in WhatsApp from the linked account or configured owner. This terminal shows command help only; replies arrive in the owner's private chat.`
            });
        } else {
            return res.json({
                output: `Command .${cmdName} not found. Type "commands" to view all loaded commands.`
            });
        }
    }

    // Execute real shell commands in Docker container
    exec(trimmed, { cwd: __dirname, timeout: 15000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
        let out = '';
        if (stdout) out += stdout;
        if (stderr) out += (out ? '\n' : '') + stderr;
        if (err && !out) out = `bash: ${err.message}`;
        if (!out.trim()) out = `(Command completed with exit code ${err ? err.code : 0})`;
        return res.json({ output: out.trim() });
    });
});

const dashboardServer = app.listen(PORT, '0.0.0.0', (listenError) => {
    // Express 5 also invokes this callback on a listen error.
    if (listenError) return;
    console.log(`Dashboard web server running at http://0.0.0.0:${PORT}`);
    // Never open an auth session until this process owns the dashboard port.
    initAllSessions().catch(err => {
        console.error('Fatal error initializing sessions:', err);
    });
});
dashboardServer.on('error', err => {
    console.error(err.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use. Exiting without opening WhatsApp sessions. Use the existing bot process.`
        : `Dashboard failed to start: ${err.message}`);
    process.exit(1);
});

// ─── Global State ─────────────────────────────────────────
global.messageCache = new MessageStore(10000);
global.antiDeleteEnabled = {};
global.antiLinkGroups = {};
global.stickerModerationGroups = {};
global.voiceModerationGroups = {};
global.photoModerationGroups = {};
global.videoModerationGroups = {};
global.documentModerationGroups = {};
global.textModerationGroups = {};
global.emojiModerationGroups = {};
global.viewOnceModerationGroups = {};
global.deleteRecoveryGroups = {};
global.welcomeGroups = {};

// ─── Load Commands (ESM dynamic import) ───────────────────
const commands = new Map();

async function loadCommands() {
    const commandsDir = path.join(__dirname, 'commands');
    if (!fs.existsSync(commandsDir)) {
        fs.mkdirSync(commandsDir, { recursive: true });
    }

    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));

    for (const file of commandFiles) {
        try {
            const filePath = path.join(commandsDir, file);
            // Use file:// URL for Windows compatibility with ESM dynamic import
            const fileUrl = new URL(`file:///${filePath.replace(/\\/g, '/')}`);
            // Cache-bust to support hot reload
            const moduleUrl = `${fileUrl.href}?t=${Date.now()}`;
            const mod = await import(moduleUrl);
            const cmd = mod.default;
            if (cmd && cmd.name) {
                commands.set(cmd.name, cmd);
                console.log(`Loaded command: .${cmd.name}`);
            }
        } catch (err) {
            console.error(`Failed to load command ${file}:`, err.message);
        }
    }

    console.log(`\n Total commands loaded: ${commands.size}\n`);
}

// ─── Auto-Reply Map ───────────────────────────────────────
const autoReplies = {
    'hello': 'Hello! How can I help you? ',
    'hi': 'Hey there!  How can I help you?',
    'hey': 'Hey! What can I do for you? ',
    'assalam o alaikum': 'Wa Alaikum Assalam! ',
    'assalamualaikum': 'Wa Alaikum Assalam! ',
    'salam': 'Wa Alaikum Assalam! ',
    'good morning': 'Good morning!  Have a great day!',
    'good night': 'Good night!  Sweet dreams!',
    'thank you': "You're welcome! ",
    'thanks': "You're welcome! ",
};

// ─── Start Specific Session ──────────────────────────────
async function startSession(session, options = {}) {
    const mode = options.mode || 'restore';
    const phoneNumber = options.phoneNumber || null;
    session.mode = mode;

    console.log('╔══════════════════════════════════════════╗');
    console.log(`║ Session: ${(session.id + ' (' + mode + ')').padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════╝\n');

    const generation = await session.cleanup();
    if (generation !== session.generation) return;
    session.state = 'starting';
    session.disconnectMessage = null;

    // Ensure required directories exist
    const dirs = ['downloads'];
    dirs.forEach(dir => {
        const dirPath = path.join(__dirname, dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    });

    // ─── CRITICAL FIX: Fetch the latest WA Web version ────
    let waVersion;
    try {
        const webVersionResult = await fetchLatestWaWebVersion({});
        if (webVersionResult.isLatest) {
            waVersion = webVersionResult.version;
            console.log(`[${session.id}] Got latest WA Web version: [${waVersion}]`);
        } else {
            throw new Error('Could not fetch WA Web version');
        }
    } catch (err) {
        try {
            const baileysVersionResult = await fetchLatestBaileysVersion();
            waVersion = baileysVersionResult.version;
        } catch (err2) {
            waVersion = [2, 3000, 1015901307];
        }
    }

    // Set up authentication for this specific session
    if (generation !== session.generation) return;
    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
    if (generation !== session.generation) return;
    const silentLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

    // Create socket connection
    const sock = makeWASocket({
        version: waVersion,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        printQRInTerminal: false,
        logger: silentLogger,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async key => session.retryMessages.get(key.id)?.message,
    });

    session.sock = sock;
    // Keep sent payloads available when a recipient asks us to re-encrypt them.
    // This cache belongs to the account and survives socket reconnects.
    const sendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (...args) => {
        // Central privacy boundary covers commands and background group events.
        // Only successful tagall output may bypass private routing.
        const groupTagAll = args[2]?.groupTagAll === true && args[0]?.endsWith('@g.us');
        if (args[2]) {
            args[2] = { ...args[2] };
            delete args[2].groupTagAll;
        }
        // Deletions must target the source chat; other visible output goes to self-chat.
        if (!args[1]?.delete && !groupTagAll) {
            const ownerNumber = session.user?.number || sock.user?.id?.split(':')[0]?.split('@')[0];
            if (!ownerNumber) return;
            const privateJid = `${ownerNumber}@s.whatsapp.net`;
            if (args[0] !== privateJid && args[1]?.react) return;
            args[0] = privateJid;
            args[2] = { ...args[2] };
            delete args[2].quoted;
        }
        args[1] = cleanOutgoingContent(args[1]);
        const sent = await sendMessage(...args);
        if (sent?.key?.id && sent.message) session.retryMessages.set(sent.key.id, sent);
        return sent;
    };

    // ─── Pairing Code Generation ──────────────────────────
    if (mode === 'pairing' && phoneNumber && !sock.authState.creds.registered) {
        session.pairingTimer = setTimeout(async () => {
            if (session.sock !== sock) return;
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                if (session.sock !== sock) return;
                console.log(`\n [${session.id}] Pairing Code for ${phoneNumber}: ${code}\n`);
                session.pairingCode = code;
                session.state = 'pairing_code';
            } catch (err) {
                if (session.sock !== sock) return;
                console.error(`[${session.id}] Failed to generate pairing code:`, err.message);
                session.state = 'idle';
                session.pairingCode = null;
            }
        }, 2000);
    }

    // ─── Connection Update Handler ────────────────────────
    sock.ev.on('connection.update', async (update) => {
        if (session.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr && session.mode === 'qr') {
            console.log(`\n [${session.id}] Scan QR code with WhatsApp:`);
            qrcodeTerminal.generate(qr, { small: true });

            session.state = 'qr';
            try {
                session.qrDataUrl = await QRCode.toDataURL(qr, {
                    margin: 2,
                    scale: 8,
                    color: { dark: '#0b141a', light: '#ffffff' }
                });
            } catch (err) {
                console.error(`[${session.id}] QR generation failed:`, err.message);
            }
        }

        if (connection === 'open') {
            session.state = 'connected';
            session.qrDataUrl = null;
            session.pairingCode = null;
            session.startTime = Date.now();
            session.user = {
                name: sock.user?.name || 'WhatsApp User',
                id: sock.user?.id,
                number: sock.user?.id?.split(':')[0]?.split('@')[0]
            };

            console.log('╔══════════════════════════════════════════╗');
            console.log(`║   [${session.id}] CONNECTED: ${(session.user.name).padEnd(20)}║`);
            console.log('╚══════════════════════════════════════════╝');
            console.log(`Number: ${session.user.number}`);
            console.log(`[${session.id}] Message listener attached. Commands: ${commands.size}; prefix: ${PREFIX}; replies go to owner's private chat.\n`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason;

            console.log(`[${session.id}] Connection closed. Status code: ${statusCode}`);

            if (statusCode === reason.loggedOut) {
                console.log(`[${session.id}] Session logged out. Clearing auth...`);
                await session.cleanup();
                session.clearAuth();
                session.state = 'idle';
                session.user = null;
                session.qrDataUrl = null;
                session.pairingCode = null;
                return;
            }
            await session.cleanup();
            session.state = 'disconnected';
            if (statusCode === reason.connectionReplaced) {
                session.disconnectMessage = 'Another bot connection replaced this session. Stop the duplicate bot, then restart this server to reconnect. Your saved login is retained.';
                console.warn(`[${session.id}] Connection replaced by another process. Stop the other bot instance before reconnecting.`);
                return;
            }
            session.disconnectMessage = 'Connection interrupted. Attempting to reconnect automatically...';
            const closedGeneration = session.generation;
            const delay = statusCode === reason.restartRequired ? 0 : 5000;
            session.reconnectTimer = setTimeout(() => {
                if (session.generation !== closedGeneration) return;
                return startSession(session, { mode: 'restore' }).catch(err => {
                    console.error(`[${session.id}] Reconnect failed:`, err.message);
                    session.state = 'disconnected';
                    session.disconnectMessage = `Reconnect failed: ${err.message}. Restart the server to try again.`;
                });
            }, delay);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ─── Message Handler ──────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (session.sock !== sock) return;
        session.lastMessageAt = new Date().toISOString();
        console.log(`[${session.id}] messages.upsert: ${type}, ${messages.length} message(s)`);

        for (const msg of messages) {
            if (isPersonalChat(msg.key?.remoteJid) && !msg.key.fromMe) {
                // Shape-only diagnostics: never log message bodies or media keys.
                console.log(`[personal-incoming] id=${msg.key.id} event=${type} viewOnce=${!!msg.key.isViewOnce} fields=${Object.keys(msg.message || {}).join(',') || 'none'} stub=${msg.messageStubType ?? 'none'}`);
            }
            if (msg.key?.id && msg.message) session.retryMessages.set(msg.key.id, msg);
            if (!shouldHandleUpsert(msg, type, session.listeningSince)) continue;
            try {
                await handleMessage(sock, msg, session);
            } catch (err) {
                console.error(`[${session.id}] Message handler error:`, err);
            }
        }
    });

    // ─── Message Update Handler (Anti-Delete) ─────────────
    sock.ev.on('messages.update', async (updates) => {
        if (session.sock !== sock) return;
        for (const update of updates) {
            try {
                await handleMessageUpdate(sock, update, session);
            } catch (err) {
                console.error(`[${session.id}] Message update handler error:`, err);
            }
        }
    });

    return sock;
}

// Fallback startBot for primary session
async function startBot(options = {}) {
    return startSession(getPrimarySession(), options);
}

// ─── Message Handler Logic ───────────────────────────────
async function handleMessage(sock, msg, session) {
    // Ignore status broadcasts and empty messages
    if (!msg.key?.remoteJid || !msg.key?.id || msg.key.remoteJid === 'status@broadcast') return;
    
    const jid = msg.key.remoteJid;
    const messageId = msg.key.id;

    // Handle protocol messages (delete/revoke)
    const protocol = normalizeIncomingMessage(msg).message?.protocolMessage;
    if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        console.log(`[delete-detection] Delete for everyone detected from=${jid} msgId=${protocol.key?.id}`);
        
        // Handle recovery for both personal and group chats
        if (jid.endsWith('@g.us')) {
            // Group message deleted - recover to owner's personal chat
            await recoverGroupDeletedMessage(sock, jid, protocol.key?.id, msg, session);
        } else {
            // Personal chat deleted - use existing recovery
            await session.personalRecovery.recover(sock, jid, protocol.key?.id, session);
        }
        return;
    }

    // Always let personalRecovery inspect messages from personal chats
    // This handles both View Once and regular messages for delete-for-everyone recovery
    await session.personalRecovery.receive(sock, msg, session);
    
    // After recovery processing, check if there's an actual message to process
    if (!msg.message && !msg.key.isViewOnce) return;

    // Deduplicate per account and chat, including append/notify redelivery.
    if (!rememberMessage(session.processedMessages, `${jid}_${messageId}`)) return;

    // Moderation runs before caching so anti-delete cannot restore banned stickers.
    if (await moderateGroupSticker(sock, msg)) return;

    // Moderate voice notes in groups - delete them silently
    if (await moderateGroupVoice(sock, msg)) return;

    // Moderate photos in groups - delete them silently
    if (await moderateGroupPhoto(sock, msg)) return;

    // Moderate videos in groups - delete them silently
    if (await moderateGroupVideo(sock, msg)) return;

    // Moderate documents in groups - delete them silently
    if (await moderateGroupDocument(sock, msg)) return;

    // Moderate text messages in groups - delete them silently (OFF by default)
    if (await moderateGroupText(sock, msg)) return;

    // Moderate emojis in text messages - delete them silently (OFF by default)
    if (await moderateGroupEmoji(sock, msg)) return;

    // Moderate View Once messages in groups - delete them silently (OFF by default)
    if (await moderateGroupViewOnce(sock, msg)) return;

    // Store every message for anti-delete feature
    const storeKey = `${jid}_${messageId}`;
    global.messageCache.set(storeKey, msg);

    // Extract text from various message types
    const text = extractMessageText(msg).trim();
    const isFromMe = msg.key.fromMe;
    const sender = msg.key.participant || msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');

    // ─── Anti-Link Check (groups) ─────────────────────────
    // By default ON in all groups, can be turned OFF with .lnk off command
    if (isGroup && global.antiLinkGroups[jid] !== false && !isFromMe) {
        const hasLink = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9]+\.(com|net|org|io|dev|me|info|xyz)[^\s]*)/gi.test(text);
        if (hasLink) {
            try {
                const metadata = await sock.groupMetadata(jid);
                const isAdmin = metadata.participants.some(p => {
                    return p.id.replace(/:\d+/, '') === sender.replace(/:\d+/, '') &&
                           (p.admin === 'admin' || p.admin === 'superadmin');
                });

                if (!isAdmin) {
                    await sock.sendMessage(jid, { delete: msg.key });
                    console.log(`[anti-link] Link deleted silently from ${jid}`);
                    return;
                }
            } catch (err) {
                // Ignore error, continue processing
            }
        }
    }

    // ─── Auto-Reply (disabled for non-owners) ──────────────
    if (false) { // Auto-reply disabled: only owner can use bot
        const lowerText = text.toLowerCase().trim();
        if (autoReplies[lowerText]) {
            let shouldReply = true;
            if (isGroup) {
                // Check if bot is an admin in this group
                try {
                    const metadata = await sock.groupMetadata(jid);
                    const botIdPart = sock.user.id.split(':')[0]; // get base number
                    const botParticipant = metadata.participants.find(p => p.id.includes(botIdPart));
                    if (!botParticipant || (botParticipant.admin !== 'admin' && botParticipant.admin !== 'superadmin')) {
                        shouldReply = false; // Not admin, do not auto-reply
                    }
                } catch (e) {
                    shouldReply = false; // Error fetching metadata, safer to not reply
                }
            }

            if (shouldReply) {
                await sock.sendMessage(jid, {
                    text: autoReplies[lowerText],
                }, { quoted: msg });
            }
            return;
        }
    }

    // ─── Command Processing ──────────────────────────────
    if (!text || !text.startsWith(PREFIX)) return;

    const fullCommand = text.slice(PREFIX.length).trim();
    const [commandName, ...args] = fullCommand.split(/\s+/);

    if (!commandName) return;

    // ─── Dynamic Owner Guard ──────────────────────────────────────────────────
    // No hardcoded OWNER_NUMBER — every connected account IS its own owner.
    // ownerJid = this session's own number (self-chat). Commands are accepted
    // only when fromMe=true (the bot account itself typed them), which means
    // any of the 5+ connected accounts can independently use all commands.
    const botNumber = session?.user?.number || sock.user?.id?.split(':')[0]?.split('@')[0];
    const ownerJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;
    const senderNumber = sender.split(':')[0].replace('@s.whatsapp.net', '');

    // Dynamic: pass null for ownerNumber so only botNumber (fromMe) is checked.
    const isOwner = await isOwnerMessage(sock, msg, null, botNumber);

    if (!isOwner) {
        console.log(`Command silently ignored from non-owner: ${senderNumber} (bot: ${botNumber})`);
        return; // Silently ignore — no reply, no indication bot exists
    }
    const senderLabel = await userLabel(sock, sender, { name: msg.pushName, phoneJid: msg.key.participantPn || msg.key.senderPn });

    const requestedName = commandName.toLowerCase();
    const command = commands.get(requestedName) ||
        [...commands.values()].find(cmd => cmd.aliases?.includes(requestedName));

    if (!command) {
        console.log(`Command not found: .${commandName}`);
        // If unknown command, notify owner privately and never expose in public/chat
        if (ownerJid) {
            await sock.sendMessage(ownerJid, {
                text: `*Unknown Command Attempt*\n\n` +
                      ` *Typed:* \`${PREFIX}${commandName}\`\n` +
                      ` *Origin:* ${isGroup ? 'Group (' + jid + ')' : 'Private Chat'}\n` +
                      `Sender: ${senderLabel}\n` +
                      ` *Note:* Ignored in chat, reported to your private chat only.`,
                mentions: [sender]
            }).catch(() => {});
        }
        return;
    }

    console.log(`Command: .${commandName} | From: ${sender} | Chat: ${jid}`);

    // Create a protected proxy socket for command execution:
    // Command output is private except successful tagall results in the source group.
    const protectedSock = new Proxy(sock, {
        get(target, prop) {
            if (prop === 'sendMessage') {
                return async (targetJid, content, options) => {
                    // Private results do not need a quote. Commands such as .op
                    // already target the owner directly, so inspecting targetJid
                    // alone used to leave cross-chat quotes attached to errors.
                    const safeOptions = options ? { ...options } : {};
                    if (targetJid === ownerJid || safeOptions.quoted?.key?.remoteJid !== targetJid) {
                        delete safeOptions.quoted;
                    }
                    if (command.name === 'tagall' && isGroup && targetJid === jid &&
                        typeof content?.text === 'string' && Array.isArray(content.mentions)) {
                        return target.sendMessage(targetJid, content, { ...safeOptions, groupTagAll: true });
                    }
                    // Route all other command output to the owner.
                    if (ownerJid && targetJid !== ownerJid) {
                        // Suppress reactions in the other person's chat to remain completely stealthy
                        if (content?.react) {
                            return;
                        }

                        console.log(`Redirecting .${commandName} output from ${targetJid} to owner ${ownerJid}`);

                        // Remove cross-chat quotation so WhatsApp renders cleanly in self-chat
                        delete safeOptions.quoted;

                        return target.sendMessage(ownerJid, content, safeOptions);
                    }

                    return target.sendMessage(targetJid, content, safeOptions);
                };
            }
            return Reflect.get(target, prop);
        }
    });

    try {
        await command.execute(protectedSock, normalizeIncomingMessage(msg), args, { commands, prefix: PREFIX, session });
    } catch (err) {
        console.error(`Command error (.${commandName}):`, err);
        // Send error report ONLY to the bot owner's private chat, NEVER in public chat
        if (ownerJid) {
            await sock.sendMessage(ownerJid, {
                text: `*Command Error Report*\n\n` +
                      ` *Command:* \`${PREFIX}${commandName}\`\n` +
                      ` *Origin:* ${isGroup ? 'Group (' + jid + ')' : 'Private Chat'}\n` +
                      `Sender: ${senderLabel}\n` +
                      ` *Error:* ${err.message || err}`,
                mentions: [sender]
            }).catch(() => {});
        }
    }
}

// ─── Utility: Extract media from anywhere ───────────────
function extractMediaMessage(message) {
    if (!message) return null;
    const wrappers = [
        'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
        'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'ptvMessage'
    ];
    for (const wrapper of wrappers) {
        if (message[wrapper] && message[wrapper].message) {
            const extracted = extractMediaMessage(message[wrapper].message);
            if (extracted) return extracted;
        }
    }
    if (message.imageMessage) return { type: 'image', msg: message.imageMessage };
    if (message.videoMessage) return { type: 'video', msg: message.videoMessage };
    if (message.audioMessage) return { type: 'audio', msg: message.audioMessage };
    if (message.documentMessage) return { type: 'document', msg: message.documentMessage };
    if (message.ptvMessage) return { type: 'video', msg: message.ptvMessage };
    return null;
}

// ─── Anti-Delete Handler ─────────────────────────────────
async function handleMessageUpdate(sock, update, session) {
    const jid = update.key?.remoteJid;
    const msgId = update.key?.id;
    console.log(`[message-update] from=${jid} msgId=${msgId} stubType=${update.update?.messageStubType}`);
    
    const protocol = normalizeIncomingMessage({ message: update.update?.message }).message?.protocolMessage;
    const isRevoke = update.update?.messageStubType === WAMessageStubType.REVOKE ||
        protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE;
    
    if (!isRevoke) {
        if (update.update?.message) {
            console.log(`[message-update] Media update detected for msgId=${msgId}`);
            const original = session.retryMessages.get(update.key?.id);
            const message = { ...original, ...update.update, key: { ...original?.key, ...update.key } };
            await session.personalRecovery.receive(sock, message, session);
        }
        return;
    }
    
    console.log(`[delete-detection] Revoke detected via messages.update from=${jid} msgId=${protocol?.key?.id || msgId}`);
    
    // Handle recovery for both personal and group chats
    if (jid.endsWith('@g.us')) {
        // Group message deleted - recover to owner's personal chat
        await recoverGroupDeletedMessage(sock, jid, protocol?.key?.id || msgId, update, session);
    } else {
        // Personal chat deleted - use existing recovery
        await session.personalRecovery.recover(sock, jid, protocol?.key?.id || msgId, session);
    }
}

// Ensure this is global so .vdt can trigger it on demand!
global.recoverDeletedMessage = async (sock, jid, revokedMsgId, session) => {
    const storeKey = `${jid}_${revokedMsgId}`;
    const originalMsg = global.messageCache.get(storeKey);

    if (!originalMsg) return false;

    const senderJid = originalMsg.key.participant || originalMsg.key.remoteJid;
    const senderLabel = await userLabel(sock, senderJid, { name: originalMsg.pushName, phoneJid: originalMsg.key.participantPn || originalMsg.key.senderPn });

    // Dynamic ownership: send recovered message to this session's own self-chat.
    const botNumber = session?.user?.number || sock.user?.id?.split('@')[0]?.split(':')[0];
    const botOwnerJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;
    if (!botOwnerJid) return false;

    try {
        const originalText = extractMessageText(originalMsg);

        let recoverText = `*Recovered message*\n`;
        recoverText += `Source: ${jid.endsWith('@g.us') ? 'Group' : 'Private chat'}\n`;
        recoverText += `From: ${senderLabel}\n`;

        if (originalText) {
            recoverText += `Message: ${originalText}\n`;
        }


        // Send ONLY to the bot owner's private chat, not in the group
        await sock.sendMessage(botOwnerJid, {
            text: recoverText,
            mentions: [senderJid],
        });

        // Try to recover media if present
        const extractedMedia = extractMediaMessage(originalMsg.message);

        if (extractedMedia) {
            try {
                const { type, msg: mediaMsg } = extractedMedia;
                
                const stream = await downloadContentFromMessage(
                    mediaMsg,
                    type === 'document' ? 'document' : type
                );

                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                const caption = ' _Recovered deleted media_';

                if (type === 'image') {
                    await sock.sendMessage(botOwnerJid, { image: buffer, caption });
                } else if (type === 'video') {
                    await sock.sendMessage(botOwnerJid, { video: buffer, caption });
                } else if (type === 'audio') {
                    await sock.sendMessage(botOwnerJid, { 
                        audio: buffer, 
                        mimetype: 'audio/mp4',
                        ptt: mediaMsg.ptt || false 
                    });
                } else if (type === 'document') {
                    await sock.sendMessage(botOwnerJid, {
                        document: buffer,
                        mimetype: mediaMsg.mimetype || 'application/octet-stream',
                        fileName: mediaMsg.fileName || 'recovered_file',
                        caption,
                    });
                }
            } catch (mediaErr) {
                console.error('Failed to recover deleted media:', mediaErr.message);
            }
        }
        return true;
    } catch (err) {
        console.error('Anti-delete error:', err);
        return false;
    }
};

// Group message recovery - forward deleted messages to owner's personal chat
async function recoverGroupDeletedMessage(sock, groupJid, revokedMsgId, deleteMsg, session) {
    // Check if delete recovery is disabled for this group
    if (global.deleteRecoveryGroups && global.deleteRecoveryGroups[groupJid] === false) {
        console.log(`[group-delete-recovery] Recovery disabled for ${groupJid}`);
        return false;
    }
    
    const storeKey = `${groupJid}_${revokedMsgId}`;
    const originalMsg = global.messageCache.get(storeKey);

    if (!originalMsg) {
        console.log(`[group-delete-recovery] Message not found in cache: ${revokedMsgId}`);
        return false;
    }

    // Get owner's personal chat JID
    const botNumber = session?.user?.number || sock.user?.id?.split('@')[0]?.split(':')[0];
    const ownerJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;
    
    if (!ownerJid) {
        console.log(`[group-delete-recovery] Owner JID not found`);
        return false;
    }

    try {
        // Get group name
        let groupName = 'Unknown Group';
        try {
            const metadata = await sock.groupMetadata(groupJid);
            groupName = metadata.subject || groupJid;
        } catch (e) {
            groupName = groupJid;
        }

        // Get sender info
        const senderJid = originalMsg.key.participant || originalMsg.key.remoteJid;
        const senderLabel = await userLabel(sock, senderJid, { 
            name: originalMsg.pushName, 
            phoneJid: originalMsg.key.participantPn || originalMsg.key.senderPn 
        });

        const originalText = extractMessageText(originalMsg);

        // Build notification message
        let notificationText = `*Deleted Message Recovered*\n\n`;
        notificationText += `*Group:* ${groupName}\n`;
        notificationText += `*From:* ${senderLabel}\n`;
        
        if (originalText) {
            notificationText += `\n*Message:*\n${originalText}`;
        }

        // Send notification to owner's personal chat
        await sock.sendMessage(ownerJid, {
            text: notificationText,
            mentions: [senderJid],
        });

        console.log(`[group-delete-recovery] Notification sent for ${revokedMsgId}`);

        // Try to recover media if present
        const extractedMedia = extractMediaMessage(originalMsg.message);

        if (extractedMedia) {
            try {
                const { type, msg: mediaMsg } = extractedMedia;
                
                const stream = await downloadContentFromMessage(
                    mediaMsg,
                    type === 'document' ? 'document' : type
                );

                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                const caption = `*Deleted ${type.toUpperCase()} from ${groupName}*`;

                if (type === 'image') {
                    await sock.sendMessage(ownerJid, { image: buffer, caption });
                } else if (type === 'video') {
                    await sock.sendMessage(ownerJid, { video: buffer, caption });
                } else if (type === 'audio') {
                    await sock.sendMessage(ownerJid, { 
                        audio: buffer, 
                        mimetype: mediaMsg.mimetype || 'audio/mp4',
                        ptt: mediaMsg.ptt || false,
                        caption
                    });
                } else if (type === 'document') {
                    await sock.sendMessage(ownerJid, {
                        document: buffer,
                        mimetype: mediaMsg.mimetype || 'application/octet-stream',
                        fileName: mediaMsg.fileName || 'recovered_file',
                        caption,
                    });
                } else if (type === 'sticker') {
                    await sock.sendMessage(ownerJid, { 
                        sticker: buffer,
                        caption
                    });
                }
                
                console.log(`[group-delete-recovery] Media sent: ${type}`);
            } catch (mediaErr) {
                console.error(`[group-delete-recovery] Failed to recover media:`, mediaErr.message);
            }
        }
        
        return true;
    } catch (err) {
        console.error(`[group-delete-recovery] Error:`, err);
        return false;
    }
}

// ─── Utility: Extract text from any message type ─────────
function extractMessageText(msg) {
    let m = msg?.message;
    if (!m) return '';

    // Unwrap common message wrappers
    const wrappers = [
        'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
        'viewOnceMessageV2Extension', 'documentWithCaptionMessage'
    ];
    for (let i = 0; i < 3; i++) { // allow nesting up to 3 levels
        let unwrapped = false;
        for (const w of wrappers) {
            if (m[w] && m[w].message) {
                m = m[w].message;
                unwrapped = true;
                break;
            }
        }
        if (!unwrapped) break;
    }

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ''
    );
}

// ─── Initialize All Sessions ──────────────────────────────
async function initAllSessions() {
    await loadCommands();
    console.log(`WhatsApp session storage: ${sessionsBaseDir}`);
    if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
        console.warn('No Railway volume detected. Attach a persistent volume at /app/auth before linking WhatsApp; otherwise redeployments can lose saved sessions.');
    }

    // Auto-migrate legacy auth if exists directly in auth/
    const legacyCreds = path.join(authBaseDir, 'creds.json');
    const primaryDir = path.join(sessionsBaseDir, 'primary');
    if (fs.existsSync(legacyCreds)) {
        console.log('Migrating legacy session to auth/sessions/primary...');
        if (!fs.existsSync(primaryDir)) fs.mkdirSync(primaryDir, { recursive: true });
        const legacyFiles = fs.readdirSync(authBaseDir);
        for (const f of legacyFiles) {
            if (f !== 'sessions') {
                const oldP = path.join(authBaseDir, f);
                const newP = path.join(primaryDir, f);
                try {
                    if (fs.statSync(oldP).isFile()) {
                        fs.renameSync(oldP, newP);
                    }
                } catch (_) {}
            }
        }
    }

    const sessionFolders = fs.existsSync(sessionsBaseDir)
        ? fs.readdirSync(sessionsBaseDir).filter(f => {
            try { return fs.statSync(path.join(sessionsBaseDir, f)).isDirectory(); } catch (_) { return false; }
        })
        : [];

    if (sessionFolders.length === 0) {
        console.log(`No saved sessions. Created 'primary' session in idle state.`);
        const primary = new WhatsAppSession('primary', 'Primary Account');
        activeSessions.set('primary', primary);
        return;
    }

    console.log(`Found ${sessionFolders.length} session(s). Booting in parallel...`);
    for (const folder of sessionFolders) {
        const sessionPath = path.join(sessionsBaseDir, folder);
        const credsPath = path.join(sessionPath, 'creds.json');
        const session = new WhatsAppSession(folder, folder === 'primary' ? 'Primary Account' : `Account (${folder})`);
        activeSessions.set(folder, session);

        if (fs.existsSync(credsPath)) {
            console.log(`Booting saved session '${folder}'...`);
            startSession(session, { mode: 'restore' }).catch(err => {
                console.error(`Failed to restore session '${folder}':`, err.message);
                session.state = 'idle';
            });
        } else {
            session.state = 'idle';
        }
    }
}

// ─── Graceful Shutdown ───────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('SIGINT', () => {
    console.log('\n\n Bot shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n Bot received SIGTERM, shutting down...');
    process.exit(0);
});
