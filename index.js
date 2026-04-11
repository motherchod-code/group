// ╔═══════════════════════════════════════════════════════════════════╗
// ║    NeuroBot — WhatsApp Pair Bot v3.1 (Fixed)                     ║
// ║    Baileys 7.0.0-rc.9 | Photo→Pair→DP→Sticker→Newsletter→Group  ║
// ╚═══════════════════════════════════════════════════════════════════╝

"use strict";

const { Telegraf }   = require("telegraf");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const pino  = require("pino");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

// ┌──────────────────────────────────────────────────────────────────┐
// │                       HARDCODED CONFIG                           │
// └──────────────────────────────────────────────────────────────────┘
const CONFIG = {
  BOT_TOKEN         : "YOUR_TELEGRAM_BOT_TOKEN",           // ← @BotFather
  GROUP_INVITE_LINK : "https://chat.whatsapp.com/XXXXXX",  // ← Group link
  NEWSLETTER_JID    : "120363407665192704@newsletter",
  SESSIONS_DIR      : path.join(__dirname, "sessions"),
  TEMP_DIR          : path.join(__dirname, "temp"),
  STICKER_PACKNAME  : "Md",
  STICKER_AUTHOR    : "Neurobot",
};

[CONFIG.SESSIONS_DIR, CONFIG.TEMP_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ┌──────────────────────────────────────────────────────────────────┐
// │                        STATE MAPS                                │
// └──────────────────────────────────────────────────────────────────┘
// pending: waiting for photo or number input
// Map<userId, { stage: "waiting_photo"|"waiting_number", photoPath? }>
const pending  = new Map();

// sessions: active WA connections
// Map<userId, { sock, number, connected }>
const sessions = new Map();

// ┌──────────────────────────────────────────────────────────────────┐
// │                     TELEGRAM BOT                                 │
// └──────────────────────────────────────────────────────────────────┘
const bot = new Telegraf(CONFIG.BOT_TOKEN);

// /start
bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🤖 *NeuroBot — WhatsApp Pair*\n\n` +
    `*Steps:*\n` +
    `1️⃣ /pair — Shuru karo\n` +
    `2️⃣ Photo bhejo (DP banega)\n` +
    `3️⃣ WhatsApp number bhejo\n` +
    `4️⃣ Pair code WhatsApp me enter karo\n\n` +
    `✅ Baaki sab automatic hoga!\n\n` +
    `• /status — Session check\n` +
    `• /cancel — Cancel`
  );
});

// /pair — start flow
bot.command("pair", async (ctx) => {
  const userId = String(ctx.from.id);

  // Kill any old session
  if (sessions.has(userId)) {
    try { sessions.get(userId).sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }
  pending.set(userId, { stage: "waiting_photo" });

  await ctx.replyWithMarkdown(
    `📸 *Step 1 — Photo Bhejo*\n\n` +
    `Apna ek photo bhejo.\n` +
    `_Yahi photo tumhara WhatsApp DP banega._`
  );
});

// /cancel
bot.command("cancel", (ctx) => {
  const userId = String(ctx.from.id);
  pending.delete(userId);
  if (sessions.has(userId)) {
    try { sessions.get(userId).sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }
  ctx.reply("❌ Cancel ho gaya. /pair se dobara shuru karo.");
});

// /status
bot.command("status", (ctx) => {
  const userId = String(ctx.from.id);
  const s = sessions.get(userId);
  if (!s) return ctx.replyWithMarkdown("❌ *Koi session nahi.*\n/pair se shuru karo.");
  ctx.replyWithMarkdown(
    `📊 *Session*\n📱 \`+${s.number}\`\n` +
    `Status: ${s.connected ? "🟢 Connected" : "🔄 Connecting..."}`
  );
});

// ── Photo handler ───────────────────────────────────────────────────
bot.on("photo", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);
  if (!state || state.stage !== "waiting_photo") return;

  try {
    const photos   = ctx.message.photo;
    const best     = photos[photos.length - 1]; // highest res
    const fileLink = await ctx.telegram.getFileLink(best.file_id);
    const photoPath = path.join(CONFIG.TEMP_DIR, `photo_${userId}.jpg`);
    await downloadFile(fileLink.href, photoPath);

    pending.set(userId, { stage: "waiting_number", photoPath });

    await ctx.replyWithMarkdown(
      `✅ *Photo Mil Gaya!*\n\n` +
      `📱 *Step 2 — Number Bhejo*\n\n` +
      `WhatsApp number country code ke saath:\n` +
      `Example: \`917288837763\`\n\n` +
      `_No +, no spaces._`
    );
  } catch (err) {
    ctx.reply(`❌ Photo error: ${err.message}`);
  }
});

// ── Number / text handler ───────────────────────────────────────────
bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);
  if (!state || state.stage !== "waiting_number") return;

  const phone = ctx.message.text.trim().replace(/[^0-9]/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return ctx.replyWithMarkdown(
      `❌ *Invalid number!*\nExample: \`917288837763\``
    );
  }

  const { photoPath } = state;
  pending.delete(userId);

  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n\n` +
    `📱 Number: \`+${phone}\`\n` +
    `🔄 Pair code generate ho raha hai...`
  );

  // Do NOT await — this is event-driven
  startWASession({
    telegramUserId : userId,
    phoneNumber    : phone,
    photoPath,
    onStep         : makeOnStep(ctx, phone),
  }).catch((err) => {
    ctx.replyWithMarkdown(`❌ Session error: \`${err.message}\``);
  });
});

// ┌──────────────────────────────────────────────────────────────────┐
// │               WHATSAPP SESSION — FIXED ORDER                     │
// │  1. Register all listeners FIRST                                 │
// │  2. THEN request pair code                                       │
// └──────────────────────────────────────────────────────────────────┘
async function startWASession({ telegramUserId, phoneNumber, photoPath, onStep }) {
  const sessionDir = path.join(CONFIG.SESSIONS_DIR, `uid_${telegramUserId}`);
  // Always wipe old/corrupt session — fresh start every time
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  // Use local version fallback — avoids network timeout on fetchLatestBaileysVersion
  let version = [2, 3000, 1015901307];
  try {
    const fetched = await fetchLatestBaileysVersion();
    if (fetched?.version) version = fetched.version;
  } catch (_) {
    console.log(`[${telegramUserId}] Using fallback WA version`);
  }
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal  : false,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser            : ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory    : false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs   : 60000,
    keepAliveIntervalMs: 10000,
  });

  sessions.set(String(telegramUserId), {
    sock,
    number   : phoneNumber,
    connected: false,
  });

  // ── STEP 1: Register connection listener FIRST ──────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    console.log(`[${telegramUserId}] connection.update →`, connection ?? "undefined");

    if (connection === "open") {
      await saveCreds();

      const entry = sessions.get(String(telegramUserId));
      if (entry) entry.connected = true;

      // ── A. Pair success ──
      await onStep("pair_success", {});
      await sleep(2000);

      // ── B. Change DP ──
      try {
        const selfJid   = jidNormalizedUser(sock.user.id);
        const imgBuffer = fs.readFileSync(photoPath);
        await sock.updateProfilePicture(selfJid, imgBuffer);
        await sendWAInbox(sock, phoneNumber,
          `✅ *Pair Successful!*\n\n` +
          `Tumhara WhatsApp NeuroBot se link ho gaya hai! 🎉\n\n` +
          `🖼️ *DP Change Ho Gayi!*\n` +
          `Tumhara naya profile picture set ho gaya.\n\n` +
          `📱 Number: +${phoneNumber}\n` +
          `⏳ Ab group join ho raha hai...`
        );
        await onStep("dp_success", {});
      } catch (err) {
        console.error("[DP Error]", err.message);
        await onStep("dp_failed", { reason: err.message });
      }

      await sleep(1500);

      // ── C. Sticker ──
      try {
        const imgBuffer     = fs.readFileSync(photoPath);
        const sticker       = new Sticker(imgBuffer, {
          pack   : CONFIG.STICKER_PACKNAME,
          author : CONFIG.STICKER_AUTHOR,
          type   : StickerTypes.FULL,
          quality: 50,
        });
        const stickerBuffer = await sticker.toBuffer();
        await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
          sticker: stickerBuffer,
        });
        await onStep("sticker_sent", {});
      } catch (err) {
        console.error("[Sticker Error]", err.message);
      }

      await sleep(1500);

      // ── D. Newsletter follow ──
      try {
        await sock.newsletterFollow(CONFIG.NEWSLETTER_JID);
        await onStep("newsletter_joined", {});
      } catch (err) {
        console.error("[Newsletter Error]", err.message);
      }

      await sleep(1500);

      // ── E. Group join ──
      await onStep("group_joining", {});
      await sendWAInbox(sock, phoneNumber,
        `🔗 *Group Join Ho Raha Hai...*\nPlease wait...`
      );
      await sleep(1000);

      const joinResult = await joinWAGroup(sock, CONFIG.GROUP_INVITE_LINK);
      if (joinResult.success) {
        await sendWAInbox(sock, phoneNumber,
          `🎉 *Sab Kuch Ho Gaya!*\n\n` +
          `✅ Pair         → Done\n` +
          `✅ DP Change    → Done\n` +
          `✅ Newsletter   → Joined\n` +
          `✅ Group        → Joined\n\n` +
          `👥 ${joinResult.groupName}\n` +
          `📱 +${phoneNumber}\n\n` +
          `🤖 Powered by NeuroBot`
        );
        await onStep("group_success", { groupName: joinResult.groupName });
      } else {
        await sendWAInbox(sock, phoneNumber,
          `⚠️ Group join fail.\nReason: ${joinResult.reason}`
        );
        await onStep("group_failed", { reason: joinResult.reason });
      }

      // ── F. Auto logout (unlink linked device) ──
      await sleep(3000);
      try {
        await sock.logout();
        console.log(`[${telegramUserId}] Auto logout done.`);
      } catch (err) {
        console.error("[Logout Error]", err.message);
      }

      sessions.delete(String(telegramUserId));
      try { fs.existsSync(photoPath) && fs.unlinkSync(photoPath); } catch (_) {}
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401 ||
        statusCode === 403;
      console.log(`[${telegramUserId}] Closed. Code: ${statusCode}, loggedOut: ${loggedOut}`);

      sessions.delete(String(telegramUserId));

      if (loggedOut) {
        // Clean corrupt session so next /pair starts fresh
        try {
          const dir = path.join(CONFIG.SESSIONS_DIR, `uid_${telegramUserId}`);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
        } catch (_) {}
        // Don't reconnect — user must /pair again
      }
      // No reconnect at all during pairing phase
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ── STEP 2: Wait for "connecting" state, then request pair code ──
  if (!sock.authState.creds.registered) {
    // Poll until socket is in connecting/open state (max 15s)
    let waited = 0;
    while (waited < 15000) {
      const ws = sock.ws;
      // readyState 0=CONNECTING, 1=OPEN
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) break;
      await sleep(500);
      waited += 500;
    }
    await sleep(2000); // extra buffer after WS ready

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const rawCode = await sock.requestPairingCode(phoneNumber);
        const code    = rawCode.match(/.{1,4}/g).join("-");
        await onStep("pair_code", { code });
        break;
      } catch (err) {
        console.error(`[${telegramUserId}] Pair attempt ${attempt}/3: ${err.message}`);
        if (attempt < 3) {
          await sleep(5000);
        } else {
          await onStep("pair_error", { msg: err.message });
          try { sock.end(); } catch (_) {}
          sessions.delete(String(telegramUserId));
        }
      }
    }
  }
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                     TELEGRAM STEP MESSAGES                       │
// └──────────────────────────────────────────────────────────────────┘
function makeOnStep(ctx, phone) {
  return async (step, data = {}) => {
    try {
      switch (step) {

        case "pair_code":
          await ctx.replyWithMarkdown(
            `🔑 *Pair Code Ready!*\n\n` +
            `┌────────────────────┐\n` +
            `│   \`${data.code}\`   │\n` +
            `└────────────────────┘\n\n` +
            `*WhatsApp me ye steps karo:*\n\n` +
            `1️⃣ WhatsApp kholo\n` +
            `2️⃣ *Settings → Linked Devices*\n` +
            `3️⃣ *Link a Device* tap karo\n` +
            `4️⃣ *Link with phone number* choose karo\n` +
            `5️⃣ Upar ka code enter karo\n\n` +
            `⏰ _Code sirf 60 sec valid hai!_\n` +
            `⏳ Waiting for link...`
          );
          break;

        case "pair_error":
          await ctx.replyWithMarkdown(
            `❌ *Pair Code Error!*\n\nError: \`${data.msg}\`\n\nDobara try: /pair`
          );
          break;

        case "pair_success":
          await ctx.replyWithMarkdown(
            `✅ *WhatsApp Pair Successful!*\n\n` +
            `📱 \`+${phone}\` connected!\n\n` +
            `🖼️ DP change ho rahi hai...`
          );
          break;

        case "dp_success":
          await ctx.replyWithMarkdown(
            `🖼️ *DP Change Ho Gayi!*\n\n` +
            `✅ Profile picture set ho gaya.\n` +
            `📨 WA inbox me confirm kiya.\n\n` +
            `🎭 Sticker bana raha hai...`
          );
          break;

        case "dp_failed":
          await ctx.replyWithMarkdown(
            `⚠️ *DP Change Fail* — \`${data.reason}\`\n\nAage jaari hai...`
          );
          break;

        case "sticker_sent":
          await ctx.replyWithMarkdown(
            `🎭 *Sticker Bhej Diya!*\n\n` +
            `📦 Pack: *${CONFIG.STICKER_PACKNAME}*\n` +
            `✍️ Author: *${CONFIG.STICKER_AUTHOR}*\n\n` +
            `📢 Newsletter join ho raha hai...`
          );
          break;

        case "newsletter_joined":
          await ctx.replyWithMarkdown(
            `📢 *Newsletter Join Ho Gaya!*\n\n` +
            `🔗 Group join ho raha hai...`
          );
          break;

        case "group_joining":
          await ctx.replyWithMarkdown(
            `🔗 *Group Join Ho Raha Hai...*\n⏳ Almost done!`
          );
          break;

        case "group_success":
          await ctx.replyWithMarkdown(
            `🎉 *Sab Kuch Complete Ho Gaya!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅  Pair          → Done\n` +
            `✅  DP Change     → Done\n` +
            `✅  Sticker       → Sent\n` +
            `✅  Newsletter    → Joined\n` +
            `✅  Group         → Joined\n` +
            `✅  Linked Device → Auto Logout\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📱 Number: \`+${phone}\`\n` +
            `👥 Group: *${data.groupName || "WhatsApp Group"}*\n\n` +
            `📨 _WA inbox me bhi confirmation bheja gaya!_\n\n` +
            `🤖 *NeuroBot — Done!*`
          );
          break;

        case "group_failed":
          await ctx.replyWithMarkdown(
            `⚠️ *Group Join Fail*\nReason: \`${data.reason}\`\n\n` +
            `✅ Pair, DP, Sticker, Newsletter — sab ho gaya.\n` +
            `Sirf group join nahi hua.`
          );
          break;
      }
    } catch (err) {
      console.error(`[onStep error: ${step}]`, err.message);
    }
  };
}

// ┌──────────────────────────────────────────────────────────────────┐
// │              SEND TO WA INBOX (self-chat)                        │
// └──────────────────────────────────────────────────────────────────┘
async function sendWAInbox(sock, phone, text) {
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
  } catch (err) {
    console.error("[WA Inbox Error]", err.message);
  }
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                   JOIN WHATSAPP GROUP                            │
// └──────────────────────────────────────────────────────────────────┘
async function joinWAGroup(sock, inviteLink) {
  try {
    const code = inviteLink.split("chat.whatsapp.com/")[1]?.trim();
    if (!code) return { success: false, reason: "Invalid link" };

    let groupName = "WhatsApp Group";
    try {
      const info = await sock.groupGetInviteInfo(code);
      groupName  = info?.subject || groupName;
    } catch (_) {}

    await sock.groupAcceptInvite(code);
    return { success: true, groupName };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                    DOWNLOAD FILE                                 │
// └──────────────────────────────────────────────────────────────────┘
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                      UTILITIES                                   │
// └──────────────────────────────────────────────────────────────────┘
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ┌──────────────────────────────────────────────────────────────────┐
// │                       LAUNCH                                     │
// └──────────────────────────────────────────────────────────────────┘
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot running...");
console.log(`📁 Sessions : ${CONFIG.SESSIONS_DIR}`);
console.log(`📁 Temp     : ${CONFIG.TEMP_DIR}`);

process.once("SIGINT",  () => { bot.stop("SIGINT");  process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });
