# WhatsApp Multi-Account Bot & Automation Platform
### Complete Installation & Deployment Guide (Docker, Non-Docker, Windows & Live VPS)

---

## Table of Contents
1. [Overview & Features](#overview--features)
2. [Project Structure & Prerequisites](#project-structure--prerequisites)
3. [Environment Configuration (.env)](#environment-configuration-env)
4. [Method 1: Run with Docker & Docker Compose (Recommended)](#method-1-run-with-docker--docker-compose-recommended)
5. [Method 2: Deploy via Portainer GUI (Linux Mint / VPS)](#method-2-deploy-via-portainer-gui-linux-mint--vps)
6. [Method 3: Run Without Docker on Linux (Node.js + PM2)](#method-3-run-without-docker-on-linux-nodejs--pm2)
7. [Method 4: Run on Windows 10 / 11 (Native & Docker)](#method-4-run-on-windows-10--11-native--docker)
8. [Method 5: Production Live Server with Domain & SSL (Nginx)](#method-5-production-live-server-with-domain--ssl-nginx)
9. [Multi-Account Management Guide](#multi-account-management-guide)
10. [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Overview & Features

This project is a high-performance, multi-device WhatsApp automation platform built with **Node.js (ESM)**, **Baileys (v6.7+)**, and a modern **Glassmorphism Web Dashboard**.

- **Multi-WhatsApp Accounts**: Run 2, 3, or more WhatsApp numbers concurrently 24/7 on a single server or PC.
- **Private output**: Bot command responses, errors, and moderation notices are sent **only to the connected account owner's self-chat**. Join/leave bot notifications are disabled everywhere. Successful `.tagall` output is the sole reply exception: it posts only in the source group. Moderation deletions and requested membership/settings changes still act on the source group.
- **Interactive Web Dashboard**:
  - Instant **8-Digit Pairing Code** (no QR scanner needed).
  - High-res **QR Code Scanner** flow.
  - Interactive **Web Terminal / Console** with live log streaming.
  - **Account Switcher & Management**: Add, switch, delete (`✕`), or bulk clean inactive accounts.
  - 100% Mobile & Desktop responsive.
- **Rich Automation Suite**:
  - `Personal Anti-Delete`: Automatically saves received personal-chat text/media when Delete for Everyone is detected; no command needed. Automatic recovery excludes groups.
  - `Personal View Once Saver`: Automatically copies incoming personal-chat View Once media to the connected account's You/self-chat. Includes sender phone number; no `.op` needed. Groups are excluded. `.op` remains available for explicit manual use.

Automatic personal saves include `From: +<sender number>` even when a contact name
is available. LID chats use WhatsApp's phone mapping; missing mappings are reported
as unavailable rather than displaying a guessed number. Audio and stickers have a
separate attribution message because they cannot carry normal captions.
Deleted-message recovery requires the bot to have received and cached the original.
The per-account cache lasts up to 24 hours, 1,000 messages, or 128 MB (whichever limit
is reached first), and resets on process restart/logout. Media up to 64 MB is cached
at receipt; larger or unavailable media produces a notice instead of a false success.
Saved copies already delivered to You remain in WhatsApp. Automatic personal recovery
is always enabled and automatic group recovery is disabled, independently of legacy
`.vdt` toggle state.

View Once saving handles later media updates with the same message ID and refreshes
expired download URLs once when WhatsApp allows it. Troubleshooting logs use
`[personal-incoming]` for received payload types and `[view-once]` for detection,
download/refresh, and self-chat delivery. These logs omit message bodies and media
keys. A placeholder without downloadable media cannot be saved until the actual
payload arrives; the bot reports this instead of claiming success.
Baileys also marks some View Once deliveries using `key.isViewOnce`, without a
message body. That marker is preserved when the phone later resends unwrapped media.
If WhatsApp never delivers the actual bytes, the bot cannot recover them from a
placeholder alone. For personal chats, `.vdt` uses the same per-account media-byte
cache as automatic recovery, so it does not depend on the deleted download URL.

### Checking message delivery

Restart the bot after updating dependencies with `npm install` and `npm start`.
Send `.ping` or `.menu` in WhatsApp from the linked account or `OWNER_NUMBER`.
Command replies are sent to the owner's private chat. The dashboard terminal
shows command help; typing `.ping` there does not send a WhatsApp message.

The logs show `messages.upsert` when a batch reaches the listener, followed by
`Command:` when an authorized command runs. `401` means the session was logged
out and must be linked again; `515` requests an automatic socket restart after
pairing. `440` means another connection replaced this one: stop the other bot
instance before reconnecting. Set `BAILEYS_LOG_LEVEL=debug` for more transport
diagnostics (these appear in the server's console).

Only fresh offline deliveries are executed; old commands from before process
startup are skipped. Run `npm test` for the mocked message and reconnect checks.
  - `AI Assistant (.ai)`: Powered by Google Gemini.
  - `Sticker Creator (.str)`: Convert an image to a sticker.
  - `Group Admin Tools`: `.add`, `.kick`, `.remove`, `.mute`, `.unmute`, `.tagall`, `.lnk`.

### Updated commands and Railway setup

| Command | Usage |
| --- | --- |
| `.ai` | `.ai your question` — Google Gemini |
| `.vdt` | `.vdt on`, `.vdt off`, or reply to a cached message to recover it |
| `.str` | Reply to an image, or send an image with caption `.str` |
| `.lnk` | `.lnk on` / `.lnk off` — anti-link protection |
| `.add` | `.add 923001234567` — include international country code |
| `.mute` | Only admins can send messages |
| `.unmute` | All group members can send messages |
| `.remove` | Remove all other removable members; connected account must be admin |

The old `.vdeletemsg`, `.sticker`, and `.antilink` names are replaced.
Broadcast and downloader commands have been removed.

In Railway, open the bot service's **Variables** and set `GEMINI_API_KEY`.
The default model is `gemini-3.5-flash`; override it with `GEMINI_MODEL` if needed.
Temporary server failures get a short retry, then fall back to `gemini-3.5-flash-lite`.
Override this with `GEMINI_FALLBACK_MODEL`, or set it empty to disable fallback.
Requests share a 30-second time budget. Invalid keys and quota errors are not retried.
Deploy the updated GitHub commit and variable changes. For local development,
put the key in the ignored `.env` file. Never commit the key.

Attach a Railway volume mounted at `/app/auth` before linking WhatsApp. Session
credentials are stored under `/app/auth/sessions`; without a volume, a new
deployment loses the login. After attaching storage, link WhatsApp again from
the bot dashboard and confirm it shows connected. An idle session cannot receive
stickers or execute any commands.

### Remove group members

`.remove` runs only for the connected account owner in the source group. It removes
other members (including other admins where WhatsApp permits), keeps the connected
account and original group creator, and sends counts privately. It stops on failed
or unconfirmed removal responses. This changes actual group membership immediately.
WhatsApp controls admin roles: joining a group cannot automatically grant admin
permissions; an existing admin must promote the connected account first.

### Keep WhatsApp linked after GitHub pushes

Vercel hosts the dashboard; its `/api` requests go to the Railway bot service.
The Railway service needs persistent storage, independently of Vercel and GitHub:

1. In Railway, attach a Volume to the **bot service** with mount path `/app/auth`.
2. Leave `AUTH_DIR` unset for automatic volume detection, or set it to `/app/auth`.
3. Run only one replica of the bot service against these sessions.
4. Redeploy, then link WhatsApp once if no saved session exists on that volume.
5. Future deployments restore the saved accounts automatically after a brief restart.

The storage directory is logged at startup. It defaults to Railway's
`RAILWAY_VOLUME_MOUNT_PATH`, then `./auth` locally; `AUTH_DIR` overrides both.
Attaching a new empty volume does not recover files lost in an earlier deployment.
If moving existing storage, copy its complete `sessions` directory to the new
volume while the bot is stopped. Never commit session files to GitHub.
Actual WhatsApp logout/revocation still requires linking again. A persistent
`AUTH_SECRET` variable separately keeps dashboard login tokens valid on restart.

**Sticker moderation is automatic in all groups where the bot is an admin.**
New stickers (including animated stickers) are deleted for everyone, and their
owner receives the moderation notice privately. Private-chat stickers are unaffected.
Removed stickers are excluded from the anti-delete cache. Welcome/leave bot notices
are disabled; moderation notices go only to the owner. Successful `.tagall` results post
only in the source group and mention its members; errors remain private.
Group commands retain the existing owner-only restriction. The owner (each connected
account) can invoke them with or without a group admin role. `.tagall` and `.lnk`
toggles do not require that role; WhatsApp still enforces the connected account’s
permissions for removing members, changing group settings, and deleting others’
messages. WhatsApp group and privacy settings may also prevent `.add` from adding
a member directly.
For sticker troubleshooting, look for `[sticker-moderation]` in the dashboard logs:
`detected`, `delete sent`, and `warning sent` show the stages reached; a skipped
or failed entry explains why moderation stopped.

---

## Project Structure & Prerequisites

```text
whatsappbot-main/
├── bot.js                  # Main server, multi-session manager & Baileys socket engine
├── Dockerfile              # Production multi-stage Docker container specification
├── docker-compose.yml      # Service orchestration & persistent volume definition
├── package.json            # Node.js dependencies
├── .env.example            # Environment variable template
├── commands/               # Modular bot command files (.menu, .ping, .ai, etc.)
├── public/                 # Responsive web dashboard (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── auth/                   # Persistent WhatsApp session keys & ratchets
│   └── sessions/           # Subfolders per connected account
└── downloads/              # Temporary storage for media & stickers
```

### System Requirements
| Requirement | Minimum | Recommended |
|---|---|---|
| **CPU** | 1 Core | 2 Cores |
| **RAM** | 512 MB (1 account) | 1 GB - 2 GB (multi-account) |
| **Storage** | 2 GB free space | 10 GB SSD |
| **Node.js** (Non-Docker) | v18.x | v20.x LTS or higher |
| **FFmpeg** (Non-Docker) | Required for stickers/audio | Installed & in system PATH |

---

## Environment Configuration (.env)

Before starting the bot, create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Or create `.env` manually with a text editor:

```ini
# Port where the web dashboard will be accessible
PORT=3000

# Bot command prefix (e.g. .menu, !menu, /menu)
PREFIX=.

# Your primary WhatsApp number with country code (no + or spaces)
OWNER_NUMBER=923320000000

# Google Gemini API key (required for .ai) for the .ai command
GEMINI_API_KEY=your_gemini_api_key_here
```

---

## Method 1: Run with Docker & Docker Compose (Recommended)

Docker is the cleanest method because FFmpeg and Node.js 20 are pre-configured inside the container, and session data is safely persisted on your host machine.

### Step 1: Install Docker & Docker Compose
- **Ubuntu / Debian / Linux Mint**:
  ```bash
  sudo apt update
  sudo apt install -y docker.io docker-compose
  sudo systemctl enable --now docker
  sudo usermod -aG docker $USER
  # Log out and log back in for group changes to take effect
  ```

### Step 2: Build & Start the Container
Navigate to the project directory and run:

```bash
cd "/path/to/whatsappbot-main"
docker compose up -d --build
```

### Step 3: Monitor Logs & Status
```bash
# View live container logs
docker compose logs -f

# Check container status
docker compose ps

# Restart the bot
docker compose restart

# Stop the bot
docker compose down
```

### Step 4: Open Dashboard
Open your browser and visit:
 **`http://localhost:3000`** (or `http://<your-server-ip>:3000`)

---

## Method 2: Deploy via Portainer GUI (Linux Mint / VPS)

If you have **Portainer** installed on Linux Mint or a home server:

1. Open your **Portainer Web Interface** (`https://<your-mint-ip>:9443` or `http://<your-mint-ip>:9000`).
2. Go to **Primary Environment** → Click **Stacks** in the left sidebar.
3. Click **"+ Add stack"**.
4. Name the stack: `whatsapp-bot`.
5. Choose **"Web editor"** and paste the contents of `docker-compose.yml`:

```yaml
services:
  whatsapp-bot:
    image: node:20-bookworm-slim
    container_name: whatsapp-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - PREFIX=.
      - OWNER_NUMBER=923320000000
      - GEMINI_API_KEY=
    volumes:
      - /home/YOUR_USERNAME/whatsapp-bot/auth:/app/auth
      - /home/YOUR_USERNAME/whatsapp-bot/downloads:/app/downloads
    working_dir: /app
    command: sh -c "apt-get update && apt-get install -y ffmpeg && npm install --omit=dev && npm start"
```
*(Or upload the full project folder and select the build method)*.

6. Under **Environment variables**, supply your `OWNER_NUMBER` and `GEMINI_API_KEY`.
7. Click **"Deploy the stack"**.
8. Once running, access the dashboard at: `http://<linux-mint-ip>:3000`.

---

## Method 3: Run Without Docker on Linux (Node.js + PM2)

If you do not want to use Docker, you can run the bot directly on any Linux distribution (Ubuntu, Debian, Linux Mint, Fedora, CentOS).

### Step 1: Install Node.js 20 LTS & FFmpeg
```bash
# Update package lists
sudo apt update

# Install curl and FFmpeg
sudo apt install -y curl ffmpeg git

# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify versions
node -v   # Should output v20.x.x
ffmpeg -version
```

### Step 2: Install Project Dependencies
```bash
cd "/path/to/whatsappbot-main"
npm install --omit=dev
```

### Step 3: Run the Bot Directly (Testing)
```bash
npm start
```
You will see:
```text
 Dashboard web server running at http://localhost:3000
 Total commands loaded: 12
```

### Step 4: Run in the Background 24/7 with PM2 (Production)
PM2 ensures the bot automatically restarts if it crashes or if the server reboots:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the bot under PM2
pm2 start bot.js --name "whatsapp-bot"

# Set up PM2 to auto-start on system boot
pm2 startup
# (Run the sudo command that PM2 prints in the terminal)

# Save the process list
pm2 save

# Useful PM2 commands:
pm2 logs whatsapp-bot       # View live logs
pm2 status                  # Check memory & CPU usage
pm2 restart whatsapp-bot    # Restart the bot
pm2 stop whatsapp-bot       # Stop the bot
```

---

## Method 4: Run on Windows 10 / 11 (Native & Docker)

You can run the bot on Windows either via **Docker Desktop** or **Native Node.js**.

### Option A: Using Docker Desktop for Windows
1. Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) (enable WSL 2 backend).
2. Extract the `whatsapp-bot-deploy.zip` to a folder (e.g., `C:\whatsapp-bot`).
3. Open **PowerShell** or **Command Prompt** inside that folder:
   ```powershell
   cd C:\whatsapp-bot
   docker compose up -d --build
   ```
4. Access `http://localhost:3000` in Chrome/Edge.

---

### Option B: Native Windows (Without Docker)

#### 1. Install Node.js
Download and install **Node.js LTS (v20+)** from [nodejs.org](https://nodejs.org/). Check the box to install build tools.

#### 2. Install FFmpeg on Windows
FFmpeg is required for `.str` and media conversions:
- **Via winget (Easiest)**:
  ```powershell
  winget install Gyan.FFmpeg
  ```
- **Or Manual**:
  1. Download the FFmpeg release zip from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/).
  2. Extract it to `C:\ffmpeg`.
  3. Add `C:\ffmpeg\bin` to your Windows **System Environment PATH**.
  4. Verify in a new Command Prompt by running `ffmpeg -version`.

#### 3. Install & Start the Bot
Open Command Prompt / PowerShell in the bot folder:
```powershell
# Navigate to folder
cd C:\Users\YourUser\Downloads\whatsappbot-main

# Install dependencies
npm install

# Start the bot
npm start
```
Open your browser at `http://localhost:3000`.

---

## Method 5: Production Live Server with Domain & SSL (Nginx)

To run your bot on a VPS (DigitalOcean, Hetzner, AWS, Linode, Contabo) with a custom domain (e.g. `https://bot.yourdomain.com`) and free SSL:

### Step 1: Point Your Domain DNS
Create an **A record** in your DNS provider (Cloudflare, Namecheap, GoDaddy):
- **Host**: `bot` (or `@`)
- **Points to**: `YOUR_VPS_PUBLIC_IP`

### Step 2: Install Nginx & Certbot on VPS
```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Step 3: Configure Nginx Reverse Proxy
Create a new configuration file:
```bash
sudo nano /etc/nginx/sites-available/whatsapp-bot
```

Paste the following configuration (replace `bot.yourdomain.com` with your domain):

```nginx
server {
    listen 80;
    server_name bot.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket support for live logs & status
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Enable the site and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 4: Issue Free SSL Certificate with Let's Encrypt
```bash
sudo certbot --nginx -d bot.yourdomain.com
```
Choose the option to automatically redirect HTTP to HTTPS.

Your dashboard is now live and secure at:
 **`https://bot.yourdomain.com`**

---

## Multi-Account Management Guide

### 1. Connecting the First Account
1. Open the dashboard at `http://localhost:3000`.
2. Enter your phone number with country code (e.g., `923320000000`).
3. Click **"Get 8-Digit Pairing Code"** (or click **"Scan with QR Code"**).
4. On your phone: Open **WhatsApp → Linked Devices → Link a Device → Link with phone number instead**.
5. Type the 8-digit code shown on screen.
6. The account will immediately connect and show  **ONLINE**.

### 2. Linking Additional WhatsApp Accounts
1. Click the green **`+ Add WhatsApp`** button on the top accounts bar.
2. Enter the second phone number (e.g. `923465400131`).
3. Enter the pairing code on the second phone.
4. Both accounts will now run in parallel 24/7!

### 3. Switching & Deleting Accounts
- **Switch View**: Click any account pill to view its live uptime, details, or disconnect it.
- **Delete Account**: Click the **`✕`** icon on any account pill to delete its session slot and clear stored authentication keys.
- **Clean Inactive**: Click **`Clean Inactive`** to remove all unlinked or disconnected slots in 1 click.

---

## Troubleshooting & FAQs

### Repeated `Over 2000 messages into the future` / unreadable messages

This means the saved Signal receiver session is too far behind the sender's
message counter. The connection can still show ONLINE while commands arrive as
ciphertext stubs and cannot execute. libsignal reports this to Baileys as
`No matching sessions found for message`.

The bot now invalidates only the affected sender device's session after two
consecutive failures, at most once per minute while failures continue. Baileys'
normal retry receipts request fresh encryption keys; account credentials and
other sender sessions are retained. Look for `Reset stale sender session` in the
logs, then send a new `.ping` from the connected account. Recovery depends on the
sender/phone responding to the retry; previously unreadable messages may not be
recoverable.

Run only one bot process per auth directory and retain the same writable auth
volume across deployments. Duplicate writers or restoring an old auth backup can
leave ratchets stale; the error alone does not establish which caused the drift.
If fresh messages still fail after updating and restarting the bot, stop duplicate
instances first, then unlink and re-pair the affected account through the dashboard.

### Phone shows `Waiting for this message` for bot replies

If the logs show `Command: .menu` but the reply is unreadable on the phone,
incoming command decryption succeeded and outgoing delivery needs attention.
Before the first private reply on each connection, the bot refreshes the account's
device list and establishes fresh outgoing sessions for its primary phone and
linked devices. Look for `Self-chat encryption refreshed` in the logs. A failed
key query blocks the send and is retried on the next command.

After deploying this fix, restart the bot and send a new `.ping` from the linked
account with WhatsApp open on the phone. Old placeholders are not automatically
replaced by this refresh. If new replies remain unreadable, unlink the bot under
WhatsApp **Linked devices**, then re-pair it through the dashboard. Confirm that
only one bot uses that account's saved auth directory.

### Q1: Pairing Code says "Timeout" or does not show on screen
- Make sure you entered the phone number with the full country code and without leading zeroes or `+` (e.g. `923320000000`, NOT `03320000000`).
- WhatsApp's servers occasionally throttle pairing code requests. If it fails, click **"Scan with QR Code"** as an instant alternative.

### Q2: FFmpeg Error when generating Stickers (`.str`)
- **If running Docker**: FFmpeg is already installed inside the container.
- **If running Non-Docker Linux**: Run `sudo apt install -y ffmpeg`.
- **If running Windows**: Run `winget install Gyan.FFmpeg` and restart your terminal.

### Q3: Port 3000 is already in use
- If another service is using port 3000:
  1. Open `.env` and change `PORT=3001`.
  2. If using Docker, update `docker-compose.yml` to `"3001:3001"`.
  3. Restart the bot.

### Q4: Will my WhatsApp session stay logged in after server reboot?
- **Yes!** The session keys are saved in `./auth/sessions/`. As long as you don't manually click Logout or Delete (`✕`), the bot will automatically reconnect without needing a QR scan or pairing code.

---

### License & Credits
Developed with  using **Baileys**, **Node.js**, and modern web standards. Built for privacy, speed, and 24/7 stability.
