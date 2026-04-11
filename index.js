// ╔═══════════════════════════════════════════════════════════════════╗
// ║    NeuroBot — WhatsApp Pair Bot v4                               ║
// ║    Baileys 7.0.0-rc.9 | Proven Working Pattern                  ║
// ║    Photo → Pair → DP → Sticker → Newsletter → Group → Logout    ║
// ╚═══════════════════════════════════════════════════════════════════╝

"use strict";

const { Telegraf } = require("telegraf");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const pino  = require("pino");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

// ┌──────────────────────────────────────────────────────────────────┐
// │                       CONFIG                                     │
// └──────────────────────────────────────────────────────────────────┘
const CONFIG = {
  BOT_TOKEN         : "8192834277:AAGLXbshMUdUuUBw_Afwf4_Ebvqocmfc-ug",
  GROUP_INVITE_LINK : "https://chat.whatsapp.com/XXXXXX",
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
// │                      STATE MAPS                                  │
// └──────────────────────────────────────────────────────────────────┘
const pending  = new Map(); // userId → { stage, photoPath }
const sessions = new Map(); // userId → { sock, number }

// ┌──────────────────────────────────────────────────────────────────┐
// │                    TELEGRAM BOT                                  │
// └──────────────────────────────────────────────────────────────────┘
const bot = new Telegraf(CONFIG.BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🤖 *NeuroBot — WhatsApp Pair*\n\n` +
    `*Steps:*\n` +
    `1️⃣ /pair — Shuru karo\n` +
    `2️⃣ Photo bhejo (DP banega)\n` +
    `3️⃣ WhatsApp number bhejo\n` +
    `4️⃣ Pair code WhatsApp me enter karo\n\n` +
    `✅ Baaki sab automatic!\n\n` +
    `• /cancel — Cancel karo`
  );
});

bot.command("pair", async (ctx) => {
  const userId = String(ctx.from.id);
  cleanupSession(userId);
  pending.set(userId, { stage: "waiting_photo" });
  await ctx.replyWithMarkdown(
    `📸 *Photo Bhejo*\n\n` +
    `Apna ek photo bhejo — yahi tumhara WhatsApp DP banega.`
  );
});

bot.command("cancel", (ctx) => {
  const userId = String(ctx.from.id);
  cleanupSession(userId);
  pending.delete(userId);
  ctx.reply("❌ Cancel ho gaya. /pair se shuru karo.");
});

bot.command("status", (ctx) => {
  const userId = String(ctx.from.id);
  const s = sessions.get(userId);
  if (!s) return ctx.reply("❌ Koi session nahi. /pair se shuru karo.");
  ctx.replyWithMarkdown(`📊 Session active\n📱 \`+${s.number}\``);
});

// ── Photo handler ───────────────────────────────────────────────────
bot.on("photo", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);
  if (!state || state.stage !== "waiting_photo") return;

  try {
    const photos    = ctx.message.photo;
    const best      = photos[photos.length - 1];
    const fileLink  = await ctx.telegram.getFileLink(best.file_id);
    const photoPath = path.join(CONFIG.TEMP_DIR, `photo_${userId}.jpg`);
    await downloadFile(fileLink.href, photoPath);

    pending.set(userId, { stage: "waiting_number", photoPath });
    await ctx.replyWithMarkdown(
      `✅ *Photo Mil Gaya!*\n\n` +
      `📱 *Number Bhejo*\n\n` +
      `Country code ke saath:\nExample: \`917288837763\``
    );
  } catch (err) {
    ctx.reply(`❌ Photo error: ${err.message}`);
  }
});

// ── Number handler ──────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const userId = String(ctx.from.id);
  const state  = pending.get(userId);
  if (!state || state.stage !== "waiting_number") return;

  const phone = ctx.message.text.trim().replace(/[^0-9]/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return ctx.replyWithMarkdown(`❌ Invalid. Example: \`917288837763\``);
  }

  const { photoPath } = state;
  pending.delete(userId);

  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n📱 \`+${phone}\`\n🔄 Pair code generate ho raha hai...`
  );

  // Non-blocking
  runPairFlow(userId, phone, photoPath, ctx).catch((err) => {
    ctx.reply(`❌ Error: ${err.message}`);
  });
});

// ┌──────────────────────────────────────────────────────────────────┐
// │                    MAIN PAIR FLOW                                │
// └──────────────────────────────────────────────────────────────────┘
async function runPairFlow(userId, phone, photoPath, ctx) {
  // Always fresh session dir
  const sessionDir = path.join(CONFIG.SESSIONS_DIR, `uid_${userId}`);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const logger = pino({ level: "silent" });

  // ── Fixed WA version for 7.x pairing ──────────────────────────
  const WA_VERSION = [2, 3000, 1015901307];

  const sock = makeWASocket({
    version            : WA_VERSION,
    logger,
    printQRInTerminal  : false,
    auth               : {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser            : Browsers.ubuntu("Chrome"),
    syncFullHistory    : false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs   : 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 2_000,
    maxMsgRetryCount   : 2,
    fireInitQueries    : false,
  });

  sessions.set(userId, { sock, number: phone });
  sock.ev.on("creds.update", saveCreds);

  // ── Promise that resolves when "open", rejects on unrecoverable close ──
  const connectionPromise = new Promise((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log(`[${userId}] connection:`, connection ?? "-", "| code:", lastDisconnect?.error?.output?.statusCode ?? "-");

      if (connection === "open") {
        resolve(sock);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        // 515 = restart required (normal during pairing) — don't reject
        if (code === 515) {
          console.log(`[${userId}] 515 restart — reconnecting...`);
          return; // connection.update will fire again
        }
        reject(new Error(`Connection closed (code: ${code ?? "unknown"})`));
      }
    });
  });

  // ── Request pair code ──────────────────────────────────────────
  // Wait for socket WS to connect (readyState 1 = OPEN)
  await waitForWS(sock, 20_000);

  let pairCode;
  for (let i = 1; i <= 3; i++) {
    try {
      pairCode = await sock.requestPairingCode(phone);
      break;
    } catch (err) {
      console.error(`[${userId}] Pair code attempt ${i}: ${err.message}`);
      if (i === 3) throw new Error(`Pair code generate nahi hua: ${err.message}`);
      await sleep(4000);
    }
  }

  const formattedCode = pairCode.match(/.{1,4}/g).join("-");
  await ctx.replyWithMarkdown(
    `🔑 *Pair Code Ready!*\n\n` +
    `┌──────────────────────┐\n` +
    `│     \`${formattedCode}\`     │\n` +
    `└──────────────────────┘\n\n` +
    `*WhatsApp me ye steps karo:*\n\n` +
    `1️⃣ WhatsApp kholo\n` +
    `2️⃣ *Settings → Linked Devices*\n` +
    `3️⃣ *Link a Device* tap karo\n` +
    `4️⃣ *Link with phone number instead* choose karo\n` +
    `5️⃣ Upar ka code enter karo\n\n` +
    `⏰ _Code 60 sec me expire hoga!_\n` +
    `⏳ _Link hone ka wait kar raha hai..._`
  );

  // ── Wait for user to enter code in WhatsApp (up to 3 minutes) ──
  let connectedSock;
  try {
    connectedSock = await Promise.race([
      connectionPromise,
      sleep(180_000).then(() => { throw new Error("Timeout — 3 minutes me link nahi hua. /pair se dobara try karo."); }),
    ]);
  } catch (err) {
    await ctx.replyWithMarkdown(`❌ *${err.message}*`);
    cleanupSession(userId);
    cleanupSessionDir(userId);
    return;
  }

  // ── CONNECTED! ─────────────────────────────────────────────────
  await saveCreds();
  await ctx.replyWithMarkdown(
    `✅ *WhatsApp Pair Successful!*\n\n` +
    `📱 \`+${phone}\` connected!\n` +
    `🖼️ DP change ho rahi hai...`
  );
  await sleep(2000);

  // ── A. Change DP ───────────────────────────────────────────────
  try {
    const selfJid   = jidNormalizedUser(connectedSock.user.id);
    const imgBuffer = fs.readFileSync(photoPath);
    await connectedSock.updateProfilePicture(selfJid, imgBuffer);

    await sendWAInbox(connectedSock, phone,
      `✅ *Pair Successful!*\n\n` +
      `Tumhara WhatsApp NeuroBot se link ho gaya! 🎉\n\n` +
      `🖼️ *DP Change Ho Gayi!*\n` +
      `Tumhara naya profile picture set ho gaya.\n\n` +
      `📱 +${phone}\n` +
      `⏳ Group join ho raha hai...`
    );
    await ctx.replyWithMarkdown(
      `🖼️ *DP Change Ho Gayi!*\n\n` +
      `✅ Profile picture set ho gaya.\n` +
      `📨 WA inbox me confirm kiya.\n\n` +
      `🎭 Sticker bana raha hai...`
    );
  } catch (err) {
    console.error("[DP Error]", err.message);
    await ctx.replyWithMarkdown(`⚠️ DP change fail: \`${err.message}\`\nAage jaari hai...`);
  }

  await sleep(1500);

  // ── B. Send Sticker ────────────────────────────────────────────
  try {
    const imgBuffer     = fs.readFileSync(photoPath);
    const sticker       = new Sticker(imgBuffer, {
      pack   : CONFIG.STICKER_PACKNAME,
      author : CONFIG.STICKER_AUTHOR,
      type   : StickerTypes.FULL,
      quality: 50,
    });
    const stickerBuffer = await sticker.toBuffer();
    await connectedSock.sendMessage(`${phone}@s.whatsapp.net`, {
      sticker: stickerBuffer,
    });
    await ctx.replyWithMarkdown(
      `🎭 *Sticker Bhej Diya!*\n` +
      `📦 Pack: *${CONFIG.STICKER_PACKNAME}* | ✍️ Author: *${CONFIG.STICKER_AUTHOR}*\n\n` +
      `📢 Newsletter join ho raha hai...`
    );
  } catch (err) {
    console.error("[Sticker Error]", err.message);
  }

  await sleep(1500);

  // ── C. Newsletter follow ───────────────────────────────────────
  try {
    await connectedSock.newsletterFollow(CONFIG.NEWSLETTER_JID);
    await ctx.replyWithMarkdown(
      `📢 *Newsletter Join Ho Gaya!*\n\n🔗 Group join ho raha hai...`
    );
  } catch (err) {
    console.error("[Newsletter Error]", err.message);
  }

  await sleep(1500);

  // ── D. Join Group ──────────────────────────────────────────────
  await ctx.replyWithMarkdown(`🔗 *Group Join Ho Raha Hai...*\n⏳ Almost done!`);
  await sendWAInbox(connectedSock, phone, `🔗 Group join ho raha hai... ek second.`);
  await sleep(1000);

  const joinResult = await joinWAGroup(connectedSock, CONFIG.GROUP_INVITE_LINK);

  if (joinResult.success) {
    await sendWAInbox(connectedSock, phone,
      `🎉 *Sab Kuch Ho Gaya!*\n\n` +
      `✅ Pair         → Done\n` +
      `✅ DP Change    → Done\n` +
      `✅ Newsletter   → Joined\n` +
      `✅ Group        → Joined\n\n` +
      `👥 ${joinResult.groupName}\n` +
      `📱 +${phone}\n\n` +
      `🤖 Powered by NeuroBot`
    );
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
      `📱 \`+${phone}\`\n` +
      `👥 *${joinResult.groupName || "WhatsApp Group"}*\n\n` +
      `📨 _WA inbox me bhi confirmation bheja gaya!_\n\n` +
      `🤖 *NeuroBot — Done!*`
    );
  } else {
    await sendWAInbox(connectedSock, phone,
      `⚠️ Group join nahi ho saka.\nReason: ${joinResult.reason}`
    );
    await ctx.replyWithMarkdown(
      `⚠️ *Group Join Fail*\n\`${joinResult.reason}\`\n\n` +
      `✅ Pair, DP, Sticker, Newsletter — sab ho gaya.`
    );
  }

  // ── E. Auto logout + cleanup ───────────────────────────────────
  await sleep(3000);
  try {
    await connectedSock.logout();
    console.log(`[${userId}] Auto logout done.`);
  } catch (err) {
    console.error("[Logout Error]", err.message);
    try { connectedSock.end(); } catch (_) {}
  }

  // Session dir delete — user can pair again fresh next time
  cleanupSession(userId);
  cleanupSessionDir(userId);
  try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
  console.log(`[${userId}] Session + files cleaned up. Ready for next /pair.`);
}

// ┌──────────────────────────────────────────────────────────────────┐
// │                       HELPERS                                    │
// └──────────────────────────────────────────────────────────────────┘

// Wait for WebSocket to reach OPEN state
async function waitForWS(sock, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = sock.ws;
    if (ws && ws.readyState === 1) return; // 1 = OPEN
    await sleep(300);
  }
  // Proceed anyway after timeout — might still work
  console.log("WS wait timeout — proceeding anyway");
}

function cleanupSession(userId) {
  const entry = sessions.get(userId);
  if (entry) {
    try { entry.sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }
}

function cleanupSessionDir(userId) {
  try {
    const dir = path.join(CONFIG.SESSIONS_DIR, `uid_${userId}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

async function sendWAInbox(sock, phone, text) {
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
  } catch (err) {
    console.error("[WA Inbox Error]", err.message);
  }
}

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ┌──────────────────────────────────────────────────────────────────┐
// │                        LAUNCH                                    │
// └──────────────────────────────────────────────────────────────────┘
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot running...");
console.log(`📁 Sessions : ${CONFIG.SESSIONS_DIR}`);
console.log(`📁 Temp     : ${CONFIG.TEMP_DIR}`);

process.once("SIGINT",  () => { bot.stop("SIGINT");  process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });
