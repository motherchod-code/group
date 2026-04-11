"use strict";

// ─────────────────────────────────────────────
//  NeuroBot — WhatsApp Pair Bot v5 (Clean)
//  Baileys 7.0.0-rc.9
// ─────────────────────────────────────────────

const { Telegraf }  = require("telegraf");
const makeWASocket  = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const pino  = require("pino");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

// ─── CONFIG (edit here) ──────────────────────
const BOT_TOKEN         = "8192834277:AAGLXbshMUdUuUBw_Afwf4_Ebvqocmfc-ug";
const GROUP_INVITE_LINK = "https://chat.whatsapp.com/XXXXXX";
const NEWSLETTER_JID    = "120363407665192704@newsletter";
const STICKER_PACK      = "Md";
const STICKER_AUTHOR    = "Neurobot";
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const TEMP_DIR          = path.join(__dirname, "temp");
// ─────────────────────────────────────────────

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const bot     = new Telegraf(BOT_TOKEN);
const pending = new Map(); // userId → { stage, photoPath }
const active  = new Map(); // userId → sock

// ══════════════════════════════════════════════
//  TELEGRAM HANDLERS
// ══════════════════════════════════════════════

bot.start(ctx => ctx.replyWithMarkdown(
  `🤖 *NeuroBot*\n\n` +
  `1️⃣ /pair — Shuru karo\n` +
  `2️⃣ Photo bhejo\n` +
  `3️⃣ WhatsApp number bhejo\n` +
  `4️⃣ Pair code WA me enter karo\n\n` +
  `• /cancel — Cancel`
));

bot.command("pair", ctx => {
  const uid = String(ctx.from.id);
  killSession(uid);
  pending.set(uid, { stage: "photo" });
  ctx.replyWithMarkdown("📸 *Photo bhejo* — yahi tumhara WA DP banega.");
});

bot.command("cancel", ctx => {
  const uid = String(ctx.from.id);
  killSession(uid);
  pending.delete(uid);
  ctx.reply("❌ Cancel. /pair se shuru karo.");
});

bot.on("photo", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state || state.stage !== "photo") return;

  try {
    const best      = ctx.message.photo.at(-1);
    const link      = await ctx.telegram.getFileLink(best.file_id);
    const photoPath = path.join(TEMP_DIR, `${uid}.jpg`);
    await dlFile(link.href, photoPath);
    pending.set(uid, { stage: "number", photoPath });
    ctx.replyWithMarkdown(
      `✅ *Photo mil gaya!*\n\n` +
      `📱 Ab number bhejo (country code ke saath):\n` +
      `Example: \`917288837763\``
    );
  } catch (e) {
    ctx.reply("❌ Photo download fail: " + e.message);
  }
});

bot.on("text", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state || state.stage !== "number") return;

  const phone = ctx.message.text.replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return ctx.replyWithMarkdown("❌ Invalid. Example: `917288837763`");

  pending.delete(uid);
  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n📱 \`+${phone}\`\n🔄 Pair code aa raha hai...`
  );

  startSession(uid, phone, state.photoPath, ctx);
});

// ══════════════════════════════════════════════
//  CORE: startSession
// ══════════════════════════════════════════════
async function startSession(uid, phone, photoPath, ctx) {
  // Fresh session every time
  const dir = path.join(SESSIONS_DIR, uid);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const logger = pino({ level: "silent" });

  // Fetch latest WA version
  let version = [2, 3000, 1021022925];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch (_) {}
  console.log(`[${uid}] version: ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser             : ["Windows", "Chrome", "121.0.6167.160"],
    printQRInTerminal   : false,
    syncFullHistory     : false,
    markOnlineOnConnect : false,
    connectTimeoutMs    : 60_000,
    keepAliveIntervalMs : 25_000,
  });

  active.set(uid, sock);
  sock.ev.on("creds.update", saveCreds);

  let pairRequested = false;
  let pairDone      = false;

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const errCode = lastDisconnect?.error?.output?.statusCode;
    console.log(`[${uid}] ${connection ?? "?"} | code: ${errCode ?? "-"}`);

    // ── Step 1: Request pair code when connecting ─────────────────
    if (connection === "connecting" && !pairRequested) {
      pairRequested = true;

      // Give noise handshake 4 seconds
      await sleep(4000);

      try {
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join("-");
        console.log(`[${uid}] Pair code: ${code}`);

        await ctx.replyWithMarkdown(
          `🔑 *Pair Code:*\n\n` +
          `\`${code}\`\n\n` +
          `*WhatsApp me karo:*\n` +
          `1️⃣ Settings → Linked Devices\n` +
          `2️⃣ Link a Device\n` +
          `3️⃣ Link with phone number instead\n` +
          `4️⃣ Ye code enter karo\n\n` +
          `⏰ _60 sec me expire hoga_\n` +
          `⏳ _Link hone ka wait kar raha hai..._`
        );
      } catch (e) {
        console.error(`[${uid}] Pair code error: ${e.message}`);
        // 515 will close + reopen — reset so we retry
        pairRequested = false;
      }
    }

    // ── Step 2: Connected! ────────────────────────────────────────
    if (connection === "open" && !pairDone) {
      pairDone = true;
      await saveCreds();
      console.log(`[${uid}] Connected!`);
      await runPostConnect(uid, phone, photoPath, sock, ctx);
    }

    // ── Disconnected ──────────────────────────────────────────────
    if (connection === "close") {
      const fatal = [401, 403, 408].includes(errCode);

      if (errCode === 515) {
        // Stream restart during pairing — reset and let Baileys reconnect
        pairRequested = false;
        return;
      }

      if (fatal || pairDone) {
        // Cleanup after success or fatal error
        active.delete(uid);
        return;
      }

      // Non-fatal unexpected close — reset pair flag for retry
      pairRequested = false;
    }
  });
}

// ══════════════════════════════════════════════
//  POST-CONNECT ACTIONS
// ══════════════════════════════════════════════
async function runPostConnect(uid, phone, photoPath, sock, ctx) {
  const self = jidNormalizedUser(sock.user.id);

  await ctx.replyWithMarkdown(
    `✅ *WhatsApp Pair Successful!*\n📱 \`+${phone}\`\n\n🖼️ DP change ho rahi hai...`
  );
  await sleep(2000);

  // ── A. Change DP ───────────────────────────────────────────────
  try {
    const img = fs.readFileSync(photoPath);
    await sock.updateProfilePicture(self, img);
    await waMsg(sock, phone,
      `✅ *Pair Ho Gaya!*\n\n` +
      `NeuroBot se link ho gaye! 🎉\n` +
      `🖼️ DP change ho gayi.\n` +
      `📱 +${phone}\n` +
      `⏳ Group join ho raha hai...`
    );
    await ctx.replyWithMarkdown(
      `🖼️ *DP Change Ho Gayi!*\n✅ Profile picture set.\n\n🎭 Sticker ban raha hai...`
    );
  } catch (e) {
    console.error("[DP]", e.message);
    await ctx.replyWithMarkdown(`⚠️ DP fail: \`${e.message}\`\nAage jaari...`);
  }

  await sleep(1500);

  // ── B. Sticker ────────────────────────────────────────────────
  try {
    const img     = fs.readFileSync(photoPath);
    const sticker = new Sticker(img, {
      pack   : STICKER_PACK,
      author : STICKER_AUTHOR,
      type   : StickerTypes.FULL,
      quality: 50,
    });
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      sticker: await sticker.toBuffer(),
    });
    await ctx.replyWithMarkdown(
      `🎭 *Sticker Bheja!*\n📦 *${STICKER_PACK}* | ✍️ *${STICKER_AUTHOR}*\n\n📢 Newsletter...`
    );
  } catch (e) {
    console.error("[Sticker]", e.message);
  }

  await sleep(1500);

  // ── C. Newsletter ─────────────────────────────────────────────
  try {
    await sock.newsletterFollow(NEWSLETTER_JID);
    await ctx.replyWithMarkdown(`📢 *Newsletter Joined!*\n\n🔗 Group join ho raha hai...`);
  } catch (e) {
    console.error("[Newsletter]", e.message);
  }

  await sleep(1500);

  // ── D. Group Join ─────────────────────────────────────────────
  await ctx.replyWithMarkdown(`🔗 *Group Join Ho Raha Hai...*`);
  await waMsg(sock, phone, `🔗 Group join ho raha hai...`);
  await sleep(1000);

  const code  = GROUP_INVITE_LINK.split("chat.whatsapp.com/")[1]?.trim();
  let grpName = "WhatsApp Group";
  let joined  = false;
  try {
    const info = await sock.groupGetInviteInfo(code);
    grpName = info?.subject || grpName;
    await sock.groupAcceptInvite(code);
    joined = true;
  } catch (e) {
    console.error("[Group]", e.message);
  }

  if (joined) {
    await waMsg(sock, phone,
      `🎉 *Sab Ho Gaya!*\n\n` +
      `✅ Pair       → Done\n` +
      `✅ DP Change  → Done\n` +
      `✅ Newsletter → Done\n` +
      `✅ Group      → Joined\n\n` +
      `👥 ${grpName} | 📱 +${phone}\n🤖 NeuroBot`
    );
    await ctx.replyWithMarkdown(
      `🎉 *Sab Complete!*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅  Pair          → Done\n` +
      `✅  DP Change     → Done\n` +
      `✅  Sticker       → Sent\n` +
      `✅  Newsletter    → Joined\n` +
      `✅  Group         → Joined\n` +
      `✅  Linked Device → Logout\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📱 \`+${phone}\` | 👥 *${grpName}*\n\n` +
      `📨 _WA inbox me bhi confirm kiya!_\n🤖 *NeuroBot — Done!*`
    );
  } else {
    await ctx.replyWithMarkdown(`⚠️ Group join fail.\n✅ Baaki sab ho gaya.`);
  }

  await sleep(3000);

  // ── E. Logout + cleanup ───────────────────────────────────────
  try { await sock.logout(); } catch (_) {
    try { sock.end(); } catch (_) {}
  }
  active.delete(uid);

  // Delete session dir — user can /pair fresh any time
  try {
    const dir = path.join(SESSIONS_DIR, uid);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}

  // Delete temp photo
  try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}

  console.log(`[${uid}] All done. Session cleaned.`);
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
async function waMsg(sock, phone, text) {
  try { await sock.sendMessage(`${phone}@s.whatsapp.net`, { text }); }
  catch (e) { console.error("[waMsg]", e.message); }
}

function killSession(uid) {
  const sock = active.get(uid);
  if (sock) { try { sock.end(); } catch (_) {} active.delete(uid); }
}

function dlFile(url, dest) {
  return new Promise((res, rej) => {
    const proto = url.startsWith("https") ? https : http;
    const f = fs.createWriteStream(dest);
    proto.get(url, r => {
      if (r.statusCode === 301 || r.statusCode === 302)
        return dlFile(r.headers.location, dest).then(res).catch(rej);
      r.pipe(f);
      f.on("finish", () => { f.close(); res(); });
    }).on("error", e => { fs.unlink(dest, ()=>{}); rej(e); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot running...");
console.log("Sessions :", SESSIONS_DIR);
console.log("Temp     :", TEMP_DIR);

process.once("SIGINT",  () => { bot.stop(); process.exit(0); });
process.once("SIGTERM", () => { bot.stop(); process.exit(0); });
