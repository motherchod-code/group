// ╔══════════════════════════════════════════════════════════════╗
// ║         WhatsApp Pair Bot — Telegram + Baileys 7.x           ║
// ║  No .env | WA Inbox SMS | Telegram Updates | Multi-Session   ║
// ╚══════════════════════════════════════════════════════════════╝

"use strict";

const { Telegraf } = require("telegraf");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs   = require("fs");

// ┌─────────────────────────────────────────────────────────────┐
// │                     HARDCODED CONFIG                        │
// └─────────────────────────────────────────────────────────────┘
const CONFIG = {
  BOT_TOKEN         : "8192834277:AAGLXbshMUdUuUBw_Afwf4_Ebvqocmfc-ug",          // ← @BotFather se lo
  GROUP_INVITE_LINK : "https://chat.whatsapp.com/IiZEACDOVTNHybmjZP6UKG?mode=gi_t", // ← Apna group link
  SESSIONS_DIR      : path.join(__dirname, "sessions"),
  RECONNECT_DELAY_MS: 5000,
};

if (!fs.existsSync(CONFIG.SESSIONS_DIR))
  fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });

// ┌─────────────────────────────────────────────────────────────┐
// │               ACTIVE SESSION MAP                            │
// │  Map<telegramUserId, { sock, number, connected }>           │
// └─────────────────────────────────────────────────────────────┘
const sessions = new Map();

// ┌─────────────────────────────────────────────────────────────┐
// │               WHATSAPP SESSION CREATOR                      │
// └─────────────────────────────────────────────────────────────┘
async function startWASession({ telegramUserId, phoneNumber, onStep }) {
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
    browser           : ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory   : false,
    markOnlineOnConnect: false,
  });

  sessions.set(String(telegramUserId), {
    sock,
    number   : phoneNumber,
    connected: false,
  });

  // ── Pair Code Request ──────────────────────────────────────
  if (!sock.authState.creds.registered) {
    await sleep(3000);
    try {
      const rawCode = await sock.requestPairingCode(phoneNumber);
      const code    = rawCode.match(/.{1,4}/g).join("-"); // XXXX-XXXX
      await onStep("pair_code", { code });
    } catch (err) {
      await onStep("pair_error", { msg: err.message });
      return;
    }
  }

  // ── Connection Events ──────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      await saveCreds();
      const entry = sessions.get(String(telegramUserId));
      if (entry) entry.connected = true;

      // Step 1 — Pair successful (Telegram)
      await onStep("pair_success", { phoneNumber });

      // Step 2 — WhatsApp inbox: pair successful message
      await sleep(1500);
      await sendWAInbox(sock, phoneNumber,
        `✅ *Pair Successful!*\n\n` +
        `Tumhara WhatsApp ab bot ke saath successfully link ho gaya hai! 🎉\n\n` +
        `📱 Number: +${phoneNumber}\n\n` +
        `🔗 Ab group join kar raha hai... please ek second wait karo.`
      );

      // Step 3 — Group join request (Telegram)
      await onStep("group_joining", {});

      // Step 4 — WhatsApp inbox: group join request message
      await sleep(1000);
      await sendWAInbox(sock, phoneNumber,
        `🔗 *Group Join Request Bheja Ja Raha Hai...*\n\n` +
        `Tumhe WhatsApp group me add kiya ja raha hai.\n` +
        `⏳ Please wait...`
      );

      // Step 5 — Actually join group
      await sleep(2000);
      const joinResult = await joinWAGroup(sock, CONFIG.GROUP_INVITE_LINK);

      if (joinResult.success) {
        // Step 6a — WhatsApp inbox: join successful
        await sendWAInbox(sock, phoneNumber,
          `🎉 *Group Join Successful!*\n\n` +
          `Tum successfully group me join ho gaye ho!\n\n` +
          `👥 Group: ${joinResult.groupName || "WhatsApp Group"}\n` +
          `📱 Number: +${phoneNumber}\n\n` +
          `✅ Sab kuch set hai. Bot active hai aur connected rahega. 🚀`
        );
        // Step 6b — Telegram: join successful
        await onStep("group_success", { groupName: joinResult.groupName });
      } else {
        // Step 6a — WhatsApp inbox: join failed
        await sendWAInbox(sock, phoneNumber,
          `⚠️ *Group Join Nahi Ho Saka*\n\n` +
          `Pair to ho gaya lekin group join fail hua.\n` +
          `Reason: ${joinResult.reason}\n\n` +
          `Admin se contact karo ya invite link check karo.`
        );
        // Step 6b — Telegram: join failed
        await onStep("group_failed", { reason: joinResult.reason });
      }
    }

    if (connection === "close") {
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (!loggedOut) {
        console.log(`[Session ${telegramUserId}] Disconnected. Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
        await sleep(CONFIG.RECONNECT_DELAY_MS);
        // Reconnect silently
        startWASession({
          telegramUserId,
          phoneNumber,
          onStep: async () => {}, // silent reconnect
        });
      } else {
        sessions.delete(String(telegramUserId));
        console.log(`[Session ${telegramUserId}] Logged out permanently.`);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// ┌─────────────────────────────────────────────────────────────┐
// │         SEND MESSAGE TO WHATSAPP INBOX (self-chat)          │
// └─────────────────────────────────────────────────────────────┘
async function sendWAInbox(sock, phoneNumber, text) {
  try {
    const jid = `${phoneNumber}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    console.log(`[WA Inbox ✓] Sent to +${phoneNumber}`);
  } catch (err) {
    console.error(`[WA Inbox ✗] ${err.message}`);
  }
}

// ┌─────────────────────────────────────────────────────────────┐
// │                   JOIN WHATSAPP GROUP                       │
// └─────────────────────────────────────────────────────────────┘
async function joinWAGroup(sock, inviteLink) {
  try {
    const code = inviteLink.split("chat.whatsapp.com/")[1]?.trim();
    if (!code) return { success: false, reason: "Invalid invite link format" };

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

// ┌─────────────────────────────────────────────────────────────┐
// │                   TELEGRAM BOT SETUP                        │
// └─────────────────────────────────────────────────────────────┘
const bot = new Telegraf(CONFIG.BOT_TOKEN);

// ── /start ────────────────────────────────────────────────────
bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🤖 *WhatsApp Pair Bot*\n\n` +
    `Apna WhatsApp number bhejo country code ke saath:\n\n` +
    `➤ \`/pair 917288837763\`\n\n` +
    `📌 *Commands:*\n` +
    `• /pair — Number pair karo\n` +
    `• /status — Session check karo\n` +
    `• /logout — Disconnect karo`
  );
});

// ── /pair ─────────────────────────────────────────────────────
bot.command("pair", async (ctx) => {
  const parts  = ctx.message.text.trim().split(/\s+/);
  const userId = String(ctx.from.id);

  if (parts.length < 2) {
    return ctx.replyWithMarkdown(
      `❌ *Galat format!*\n\nSahi tarika:\n\`/pair 917288837763\``
    );
  }

  const phone = parts[1].replace(/[^0-9]/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return ctx.replyWithMarkdown(
      `❌ *Invalid number!*\n\nCountry code ke saath poora number do.\nExample: \`917288837763\``
    );
  }

  // Purana session band karo
  if (sessions.has(userId)) {
    try { sessions.get(userId).sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }

  await ctx.replyWithMarkdown(
    `⏳ *Pair code generate ho raha hai...*\n\n` +
    `📱 Number: \`+${phone}\`\n` +
    `🔄 Ek second wait karo...`
  );

  // Step callback
  const onStep = async (step, data = {}) => {
    switch (step) {

      case "pair_code":
        await ctx.replyWithMarkdown(
          `🔑 *Pair Code Ready!*\n\n` +
          `┌──────────────────┐\n` +
          `│   \`${data.code}\`   │\n` +
          `└──────────────────┘\n\n` +
          `*Phone me ye steps karo:*\n\n` +
          `1️⃣ WhatsApp kholo\n` +
          `2️⃣ *Settings → Linked Devices*\n` +
          `3️⃣ *Link a Device* tap karo\n` +
          `4️⃣ *Link with phone number* choose karo\n` +
          `5️⃣ Upar ka code enter karo\n\n` +
          `⏰ _Code sirf 60 seconds valid hai!_\n` +
          `⏳ Link hone ka wait kar raha hai...`
        );
        break;

      case "pair_error":
        await ctx.replyWithMarkdown(
          `❌ *Pair Code Generate Nahi Hua!*\n\n` +
          `Error: \`${data.msg}\`\n\n` +
          `Dobara try karo: \`/pair ${phone}\``
        );
        break;

      case "pair_success":
        await ctx.replyWithMarkdown(
          `✅ *WhatsApp Pair Ho Gaya!*\n\n` +
          `📱 Number: \`+${phone}\`\n` +
          `🟢 Status: Connected\n\n` +
          `📨 WhatsApp inbox me confirmation message bheja ja raha hai...\n` +
          `🔗 Ab group join hoga...`
        );
        break;

      case "group_joining":
        await ctx.replyWithMarkdown(
          `🔗 *Group Join Request Bheja Ja Raha Hai...*\n\n` +
          `⏳ Please wait, almost done!`
        );
        break;

      case "group_success":
        await ctx.replyWithMarkdown(
          `🎉 *Sab Kuch Successfully Complete Hua!*\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `✅  Pair     →  Successful\n` +
          `✅  Group    →  Joined\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📱 Number: \`+${phone}\`\n` +
          `👥 Group: *${data.groupName || "WhatsApp Group"}*\n\n` +
          `📨 _Tumhare WhatsApp inbox me bhi join confirmation bhej diya gaya hai!_\n\n` +
          `🤖 Bot active hai. Auto-reconnect enabled. 🚀`
        );
        break;

      case "group_failed":
        await ctx.replyWithMarkdown(
          `⚠️ *Pair Hua, Group Join Nahi Hua*\n\n` +
          `✅  Pair   →  Successful\n` +
          `❌  Group  →  Failed\n\n` +
          `Reason: \`${data.reason}\`\n\n` +
          `_Shayad already member ho ya link expire ho gaya ho._`
        );
        break;
    }
  };

  try {
    await startWASession({ telegramUserId: userId, phoneNumber: phone, onStep });
  } catch (err) {
    await ctx.replyWithMarkdown(`❌ *Error:* \`${err.message}\``);
  }
});

// ── /status ───────────────────────────────────────────────────
bot.command("status", async (ctx) => {
  const userId = String(ctx.from.id);
  const entry  = sessions.get(userId);

  if (!entry) {
    return ctx.replyWithMarkdown(
      `❌ *Koi active session nahi.*\n\n\`/pair 917288837763\` se pair karo.`
    );
  }

  ctx.replyWithMarkdown(
    `📊 *Session Status*\n\n` +
    `📱 Number: \`+${entry.number}\`\n` +
    `🟢 Status: ${entry.connected ? "Connected ✅" : "Connecting... 🔄"}`
  );
});

// ── /logout ───────────────────────────────────────────────────
bot.command("logout", async (ctx) => {
  const userId = String(ctx.from.id);
  const entry  = sessions.get(userId);

  if (!entry) return ctx.reply("❌ Koi active session nahi mila.");

  // WhatsApp inbox me bye message
  try {
    await sendWAInbox(entry.sock, entry.number,
      `👋 *Session Disconnect Ho Gaya*\n\n` +
      `Tumhara WhatsApp bot se disconnect kar diya gaya hai.\n\n` +
      `Dobara pair karne ke liye Telegram par /pair command use karo.`
    );
    await sleep(1000);
    await entry.sock.logout();
  } catch (_) {}

  sessions.delete(userId);
  const sessionDir = path.join(CONFIG.SESSIONS_DIR, `uid_${userId}`);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });

  ctx.replyWithMarkdown(
    `✅ *Logout Successful!*\n\n` +
    `📱 \`+${entry.number}\` disconnect ho gaya.\n` +
    `🗑️ Session delete ho gaya.\n\n` +
    `_Dobara pair karne ke liye /pair use karo._`
  );
});

// ── /sessions (admin) ─────────────────────────────────────────
bot.command("sessions", (ctx) => {
  if (sessions.size === 0)
    return ctx.reply("📭 Koi active session nahi hai.");

  let msg = `📊 *Active Sessions: ${sessions.size}*\n\n`;
  sessions.forEach((val, key) => {
    const status = val.connected ? "🟢 Connected" : "🔄 Connecting";
    msg += `• User \`${key}\`\n  📱 \`+${val.number}\`  [${status}]\n\n`;
  });
  ctx.replyWithMarkdown(msg);
});

// ┌─────────────────────────────────────────────────────────────┐
// │                      UTILITIES                              │
// └─────────────────────────────────────────────────────────────┘
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ┌─────────────────────────────────────────────────────────────┐
// │                     BOT LAUNCH                              │
// └─────────────────────────────────────────────────────────────┘
bot.launch({ dropPendingUpdates: true });
console.log("🤖 WhatsApp Pair Bot is running...");
console.log(`📁 Sessions: ${CONFIG.SESSIONS_DIR}`);

process.once("SIGINT",  () => { bot.stop("SIGINT");  process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });
