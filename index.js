// ╔═══════════════════════════════════════════════════════════════════╗
// ║    WhatsApp Pair Bot v3 — Baileys 7.0.0-rc.9 + Telegraf         ║
// ║  Photo → Pair Code → DP Change → Sticker → Newsletter → Logout  ║
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
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const pino   = require("pino");
const path   = require("path");
const fs     = require("fs");
const https  = require("https");
const http   = require("http");

// ┌──────────────────────────────────────────────────────────────────┐
// │                       HARDCODED CONFIG                           │
// └──────────────────────────────────────────────────────────────────┘
const CONFIG = {
  BOT_TOKEN          : "8192834277:AAGLXbshMUdUuUBw_Afwf4_Ebvqocmfc-ug",           // ← @BotFather
  GROUP_INVITE_LINK  : "https://chat.whatsapp.com/IiZEACDOVTNHybmjZP6UKG?mode=gi_t",  // ← Group link
  NEWSLETTER_JID     : "120363407665192704@newsletter",      // ← Newsletter JID
  SESSIONS_DIR       : path.join(__dirname, "sessions"),
  TEMP_DIR           : path.join(__dirname, "temp"),
  STICKER_PACKNAME   : "Md",
  STICKER_AUTHOR     : "Neurobot",
  RECONNECT_DELAY_MS : 5000,
};

[CONFIG.SESSIONS_DIR, CONFIG.TEMP_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ┌──────────────────────────────────────────────────────────────────┐
// │              PENDING USERS (awaiting photo / number)             │
// │  Map<telegramUserId, { stage, photoBuffer?, photoPath? }>        │
// └──────────────────────────────────────────────────────────────────┘
const pending  = new Map(); // stage: "waiting_photo" | "waiting_number"
const sessions = new Map(); // active WA sessions

// ┌──────────────────────────────────────────────────────────────────┐
// │                     TELEGRAM BOT SETUP                           │
// └──────────────────────────────────────────────────────────────────┘
const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ── /start ─────────────────────────────────────────────────────────
bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🤖 *NeuroBot — WhatsApp Pair*\n\n` +
    `Niche diye steps follow karo:\n\n` +
    `*Step 1️⃣* → /pair command diye shuru karo\n` +
    `*Step 2️⃣* → Apna photo bhejo (WhatsApp DP hogi)\n` +
    `*Step 3️⃣* → Apna WhatsApp number bhejo\n` +
    `*Step 4️⃣* → Pair code WhatsApp me enter karo\n\n` +
    `✅ Sab automatic ho jayega!\n\n` +
    `📌 *Commands:*\n` +
    `• /pair — Shuru karo\n` +
    `• /status — Session check karo\n` +
    `• /cancel — Cancel karo`
  );
});

// ── /pair ──────────────────────────────────────────────────────────
bot.command("pair", async (ctx) => {
  const userId = String(ctx.from.id);

  // Kill existing session
  if (sessions.has(userId)) {
    try { sessions.get(userId).sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }

  // Set stage: waiting for photo
  pending.set(userId, { stage: "waiting_photo" });

  await ctx.replyWithMarkdown(
    `📸 *Step 1: Photo Bhejo*\n\n` +
    `Apna ek photo bhejo — ye tumhara WhatsApp DP ban jayega.\n\n` +
    `_Photo bhejne ke baad number maanga jayega._`
  );
});

// ── /cancel ────────────────────────────────────────────────────────
bot.command("cancel", async (ctx) => {
  const userId = String(ctx.from.id);
  pending.delete(userId);
  if (sessions.has(userId)) {
    try { sessions.get(userId).sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }
  ctx.reply("❌ Process cancel ho gaya. /pair se dobara shuru karo.");
});

// ── /status ────────────────────────────────────────────────────────
bot.command("status", async (ctx) => {
  const userId = String(ctx.from.id);
  const entry  = sessions.get(userId);
  if (!entry) return ctx.replyWithMarkdown("❌ *Koi active session nahi.*\n\n/pair se shuru karo.");
  ctx.replyWithMarkdown(
    `📊 *Session Status*\n\n` +
    `📱 Number: \`+${entry.number}\`\n` +
    `🟢 Status: ${entry.connected ? "Connected ✅" : "Processing... 🔄"}`
  );
});

// ── PHOTO HANDLER ──────────────────────────────────────────────────
bot.on("photo", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);
  if (!state || state.stage !== "waiting_photo") return;

  try {
    // Get highest resolution photo
    const photos   = ctx.message.photo;
    const best     = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(best.file_id);
    const photoUrl = fileLink.href;

    // Download photo to temp
    const photoPath = path.join(CONFIG.TEMP_DIR, `photo_${userId}.jpg`);
    await downloadFile(photoUrl, photoPath);

    // Update state
    pending.set(userId, { stage: "waiting_number", photoPath });

    await ctx.replyWithMarkdown(
      `✅ *Photo Receive Ho Gaya!*\n\n` +
      `📱 *Step 2: WhatsApp Number Bhejo*\n\n` +
      `Apna WhatsApp number bhejo country code ke saath:\n` +
      `Example: \`917288837763\`\n\n` +
      `_Koi + ya space nahi_`
    );
  } catch (err) {
    ctx.reply(`❌ Photo download error: ${err.message}`);
  }
});

// ── TEXT / NUMBER HANDLER ──────────────────────────────────────────
bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);

  // Not in waiting_number stage — ignore
  if (!state || state.stage !== "waiting_number") return;

  const phone = ctx.message.text.trim().replace(/[^0-9]/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return ctx.replyWithMarkdown(
      `❌ *Invalid number!*\n\nSahi format:\n\`917288837763\`\n\n_Sirf digits, no + or spaces._`
    );
  }

  const { photoPath } = state;
  pending.delete(userId); // Done collecting

  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n\n` +
    `📱 Number: \`+${phone}\`\n` +
    `🔄 Pair code generate ho raha hai...`
  );

  // Build step callback
  const onStep = makeStepCallback(ctx, phone, photoPath);

  try {
    await startWASession({ telegramUserId: userId, phoneNumber: phone, photoPath, onStep });
  } catch (err) {
    ctx.replyWithMarkdown(`❌ *Error:* \`${err.message}\``);
  }
});

// ┌──────────────────────────────────────────────────────────────────┐
// │                 STEP CALLBACK (Telegram messages)                │
// └──────────────────────────────────────────────────────────────────┘
function makeStepCallback(ctx, phone, photoPath) {
  return async (step, data = {}) => {
    switch (step) {

      case "pair_code":
        await ctx.replyWithMarkdown(
          `🔑 *Pair Code Ready!*\n\n` +
          `┌──────────────────────┐\n` +
          `│    \`${data.code}\`    │\n` +
          `└──────────────────────┘\n\n` +
          `*WhatsApp me ye steps karo:*\n\n` +
          `1️⃣ WhatsApp kholo\n` +
          `2️⃣ *Settings → Linked Devices*\n` +
          `3️⃣ *Link a Device* tap karo\n` +
          `4️⃣ *Link with phone number* choose karo\n` +
          `5️⃣ Code enter karo\n\n` +
          `⏰ _Code 60 seconds me expire hoga!_\n` +
          `⏳ Link hone ka wait kar raha hai...`
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
          `📱 Number: \`+${phone}\`\n` +
          `🟢 Status: Connected\n\n` +
          `🖼️ Ab DP change ho rahi hai...`
        );
        break;

      case "dp_success":
        await ctx.replyWithMarkdown(
          `🖼️ *DP Change Successful!*\n\n` +
          `✅ Tumhara WhatsApp DP set ho gaya.\n\n` +
          `📨 WhatsApp inbox me bhi confirm kiya gaya.\n` +
          `🔗 Ab group join hoga...`
        );
        break;

      case "dp_failed":
        await ctx.replyWithMarkdown(
          `⚠️ *DP Change Nahi Hua*\n\nReason: \`${data.reason}\`\n\nAage process jaari hai...`
        );
        break;

      case "sticker_sent":
        await ctx.replyWithMarkdown(
          `🎭 *Sticker Bhi Bhej Diya!*\n\n` +
          `📦 Pack: *${CONFIG.STICKER_PACKNAME}*\n` +
          `✍️ Author: *${CONFIG.STICKER_AUTHOR}*\n\n` +
          `Tumhare WhatsApp inbox me sticker bheja gaya hai.`
        );
        break;

      case "newsletter_joined":
        await ctx.replyWithMarkdown(
          `📢 *Newsletter Join Ho Gaya!*\n\n` +
          `✅ Successfully channel follow kiya.`
        );
        break;

      case "group_joining":
        await ctx.replyWithMarkdown(
          `🔗 *Group Join Ho Raha Hai...*\n\n⏳ Almost done!`
        );
        break;

      case "group_success":
        await ctx.replyWithMarkdown(
          `🎉 *Sab Kuch Complete!*\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `✅  Pair          →  Done\n` +
          `✅  DP Change     →  Done\n` +
          `✅  Sticker       →  Sent\n` +
          `✅  Newsletter    →  Joined\n` +
          `✅  Group         →  Joined\n` +
          `✅  Linked Device →  Auto Logout\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📱 Number: \`+${phone}\`\n` +
          `👥 Group: *${data.groupName || "WhatsApp Group"}*\n\n` +
          `📨 _WhatsApp inbox me bhi complete confirmation bheja gaya!_`
        );
        break;

      case "group_failed":
        await ctx.replyWithMarkdown(
          `⚠️ *Group Join Fail*\n\nReason: \`${data.reason}\``
        );
        break;
    }
  };
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                   WHATSAPP SESSION CREATOR                       │
// └──────────────────────────────────────────────────────────────────┘
async function startWASession({ telegramUserId, phoneNumber, photoPath, onStep }) {
  const sessionDir = path.join(CONFIG.SESSIONS_DIR, `uid_${telegramUserId}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();
  const logger               = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal : false,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser            : ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory    : false,
    markOnlineOnConnect: false,
  });

  sessions.set(String(telegramUserId), {
    sock,
    number   : phoneNumber,
    connected: false,
  });

  // ── Pair Code ────────────────────────────────────────────────
  if (!sock.authState.creds.registered) {
    await sleep(3000);
    try {
      const rawCode = await sock.requestPairingCode(phoneNumber);
      const code    = rawCode.match(/.{1,4}/g).join("-");
      await onStep("pair_code", { code });
    } catch (err) {
      await onStep("pair_error", { msg: err.message });
      return;
    }
  }

  // ── Connection Events ────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      await saveCreds();
      const entry = sessions.get(String(telegramUserId));
      if (entry) entry.connected = true;

      // ── 1. Pair Successful ──
      await onStep("pair_success", {});
      await sleep(2000);

      // ── 2. Change DP ──
      const selfJid  = jidNormalizedUser(sock.user?.id || "");
      const dpResult = await changeDP(sock, selfJid, photoPath);

      if (dpResult.success) {
        // WhatsApp inbox — pair + DP confirm
        await sendWAInbox(sock, phoneNumber,
          `✅ *Pair Successful!*\n\n` +
          `Tumhara WhatsApp bot ke saath link ho gaya.\n\n` +
          `🖼️ *DP Successfully Change Ho Gayi!*\n` +
          `Tumhara naya profile picture set ho gaya hai.\n\n` +
          `📱 Number: +${phoneNumber}\n\n` +
          `⏳ Ab group join ho raha hai...`
        );
        await onStep("dp_success", {});
      } else {
        await onStep("dp_failed", { reason: dpResult.reason });
      }

      await sleep(1500);

      // ── 3. Send Sticker to self inbox ──
      try {
        const imgBuffer = fs.readFileSync(photoPath);
        const sticker   = new Sticker(imgBuffer, {
          pack   : CONFIG.STICKER_PACKNAME,
          author : CONFIG.STICKER_AUTHOR,
          type   : StickerTypes.FULL,
          quality: 50,
        });
        const stickerBuffer = await sticker.toBuffer();
        const selfJidFull   = `${phoneNumber}@s.whatsapp.net`;
        await sock.sendMessage(selfJidFull, {
          sticker: stickerBuffer,
        });
        await onStep("sticker_sent", {});
      } catch (err) {
        console.error("[Sticker Error]", err.message);
      }

      await sleep(1500);

      // ── 4. Follow Newsletter ──
      try {
        await sock.newsletterFollow(CONFIG.NEWSLETTER_JID);
        await onStep("newsletter_joined", {});
      } catch (err) {
        console.error("[Newsletter Error]", err.message);
      }

      await sleep(1500);

      // ── 5. Join Group ──
      await onStep("group_joining", {});
      await sendWAInbox(sock, phoneNumber,
        `🔗 *Group Join Ho Raha Hai...*\n\nPlease wait ek second...`
      );

      await sleep(1000);
      const joinResult = await joinWAGroup(sock, CONFIG.GROUP_INVITE_LINK);

      if (joinResult.success) {
        // WhatsApp inbox — full success
        await sendWAInbox(sock, phoneNumber,
          `🎉 *Sab Kuch Successfully Ho Gaya!*\n\n` +
          `✅ Pair        → Done\n` +
          `✅ DP Change   → Done\n` +
          `✅ Newsletter  → Joined\n` +
          `✅ Group       → Joined\n\n` +
          `👥 Group: ${joinResult.groupName || "WhatsApp Group"}\n` +
          `📱 Number: +${phoneNumber}\n\n` +
          `🤖 Powered by NeuroBot`
        );
        await onStep("group_success", { groupName: joinResult.groupName });
      } else {
        await sendWAInbox(sock, phoneNumber,
          `⚠️ Group join nahi ho saka.\nReason: ${joinResult.reason}`
        );
        await onStep("group_failed", { reason: joinResult.reason });
      }

      // ── 6. Auto Logout (unlink linked device) ──
      await sleep(3000);
      try {
        await sock.logout();
        console.log(`[Session ${telegramUserId}] Auto-logged out after completion.`);
      } catch (err) {
        console.error("[Auto Logout Error]", err.message);
      }

      // Cleanup session + temp file
      sessions.delete(String(telegramUserId));
      try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
    }

    if (connection === "close") {
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (!loggedOut && sessions.has(String(telegramUserId))) {
        // Only reconnect if session wasn't intentionally removed
        console.log(`[Session ${telegramUserId}] Unexpected close. Reconnecting...`);
        await sleep(CONFIG.RECONNECT_DELAY_MS);
        startWASession({
          telegramUserId,
          phoneNumber,
          photoPath,
          onStep: async () => {},
        });
      } else {
        sessions.delete(String(telegramUserId));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                     CHANGE WHATSAPP DP                           │
// └──────────────────────────────────────────────────────────────────┘
async function changeDP(sock, jid, photoPath) {
  try {
    const imgBuffer = fs.readFileSync(photoPath);
    await sock.updateProfilePicture(jid, imgBuffer);
    console.log(`[DP ✓] Changed for ${jid}`);
    return { success: true };
  } catch (err) {
    console.error("[DP ✗]", err.message);
    return { success: false, reason: err.message };
  }
}

// ┌──────────────────────────────────────────────────────────────────┐
// │              SEND MESSAGE TO WA INBOX (self-chat)                │
// └──────────────────────────────────────────────────────────────────┘
async function sendWAInbox(sock, phoneNumber, text) {
  try {
    await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text });
    console.log(`[WA Inbox ✓] → +${phoneNumber}`);
  } catch (err) {
    console.error(`[WA Inbox ✗]`, err.message);
  }
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                    JOIN WHATSAPP GROUP                           │
// └──────────────────────────────────────────────────────────────────┘
async function joinWAGroup(sock, inviteLink) {
  try {
    const code = inviteLink.split("chat.whatsapp.com/")[1]?.trim();
    if (!code) return { success: false, reason: "Invalid invite link" };

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
// │                    DOWNLOAD FILE HELPER                          │
// └──────────────────────────────────────────────────────────────────┘
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto  = url.startsWith("https") ? https : http;
    const file   = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                        UTILITIES                                 │
// └──────────────────────────────────────────────────────────────────┘
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ┌──────────────────────────────────────────────────────────────────┐
// │                        BOT LAUNCH                                │
// └──────────────────────────────────────────────────────────────────┘
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot WhatsApp Pair is running...");
console.log(`📁 Sessions : ${CONFIG.SESSIONS_DIR}`);
console.log(`📁 Temp     : ${CONFIG.TEMP_DIR}`);

process.once("SIGINT",  () => { bot.stop("SIGINT");  process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });
