"use strict";

// ─────────────────────────────────────────────────────
//  NeuroBot v6 — Proton/MD style recursive pattern
//  515 → new socket created, pair code re-requested
// ─────────────────────────────────────────────────────

const { Telegraf } = require("telegraf");
const {
  default: makeWASocket,
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

// ─── CONFIG ───────────────────────────────────────────
const BOT_TOKEN         = "8192834277:AAGLXbshMUdUuUBw_Afwf4_Ebvqocmfc-ug";
const GROUP_INVITE_LINK = "https://chat.whatsapp.com/XXXXXX";
const NEWSLETTER_JID    = "120363407665192704@newsletter";
const STICKER_PACK      = "Md";
const STICKER_AUTHOR    = "Neurobot";
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const TEMP_DIR          = path.join(__dirname, "temp");
// ─────────────────────────────────────────────────────

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const bot     = new Telegraf(BOT_TOKEN);
const pending = new Map(); // uid → { stage, photoPath }
const active  = new Map(); // uid → sock

// ═══════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════

bot.start(ctx => ctx.replyWithMarkdown(
  `🤖 *NeuroBot*\n\n` +
  `1️⃣ /pair — Shuru karo\n` +
  `2️⃣ Photo bhejo\n` +
  `3️⃣ Number bhejo\n` +
  `4️⃣ Pair code WA me enter karo\n\n` +
  `/cancel — Cancel`
));

bot.command("pair", ctx => {
  const uid = String(ctx.from.id);
  killSock(uid);
  pending.set(uid, { stage: "photo" });
  ctx.replyWithMarkdown("📸 *Photo bhejo* — WA DP banega.");
});

bot.command("cancel", ctx => {
  const uid = String(ctx.from.id);
  killSock(uid);
  pending.delete(uid);
  ctx.reply("❌ Cancel. /pair se shuru karo.");
});

bot.on("photo", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state || state.stage !== "photo") return;
  try {
    const link      = await ctx.telegram.getFileLink(ctx.message.photo.at(-1).file_id);
    const photoPath = path.join(TEMP_DIR, `${uid}.jpg`);
    await dlFile(link.href, photoPath);
    pending.set(uid, { stage: "number", photoPath });
    ctx.replyWithMarkdown(
      `✅ *Photo mil gaya!*\n\n📱 Number bhejo:\nExample: \`917288837763\``
    );
  } catch (e) { ctx.reply("❌ " + e.message); }
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

  // Fresh session dir
  const dir = path.join(SESSIONS_DIR, uid);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  connectWA({ uid, phone, photoPath: state.photoPath, ctx, isReconnect: false });
});

// ═══════════════════════════════════════════════════
//  CORE: connectWA — recursive on 515
// ═══════════════════════════════════════════════════
async function connectWA({ uid, phone, photoPath, ctx, isReconnect }) {
  const dir = path.join(SESSIONS_DIR, uid);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const logger = pino({ level: "silent" });

  // WA version
  let version = [2, 3000, 1021022925];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch (_) {}

  console.log(`[${uid}] ${isReconnect ? "reconnect" : "start"} | version: ${version.join(".")}`);

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

  let codeSent = false;
  let openDone = false;

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const errCode = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${uid}] ${connection ?? "?"} | ${errCode ?? "-"}`);

    // ── Pair code on connecting ──────────────────────────────────
    if (connection === "connecting" && !codeSent) {
      codeSent = true;
      await sleep(4000); // noise handshake time

      try {
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join("-");
        console.log(`[${uid}] code: ${code}`);

        if (!isReconnect) {
          // First time — show code to user
          await ctx.replyWithMarkdown(
            `🔑 *Pair Code:*\n\n` +
            `\`${code}\`\n\n` +
            `*WA me karo:*\n` +
            `1️⃣ Settings → Linked Devices\n` +
            `2️⃣ Link a Device\n` +
            `3️⃣ Link with phone number instead\n` +
            `4️⃣ Code enter karo\n\n` +
            `⏰ _60 sec me expire — WA me jaldi enter karo_\n` +
            `⏳ _Waiting..._`
          );
        } else {
          // Reconnect — just log, don't spam user
          console.log(`[${uid}] Reconnect pair code sent silently`);
        }
      } catch (e) {
        console.error(`[${uid}] pair code error: ${e.message}`);
        codeSent = false; // allow retry
      }
    }

    // ── Open → run post-connect flow ─────────────────────────────
    if (connection === "open" && !openDone) {
      openDone = true;
      await saveCreds();
      console.log(`[${uid}] OPEN — connected!`);
      await runPostConnect({ uid, phone, photoPath, sock, ctx });
    }

    // ── Close handling ────────────────────────────────────────────
    if (connection === "close") {

      if (openDone) {
        // Already done — normal post-logout close, ignore
        active.delete(uid);
        return;
      }

      if (errCode === 515) {
        // Stream restart — Baileys closes old socket, we create new one
        console.log(`[${uid}] 515 stream restart → new socket`);
        active.delete(uid);
        await sleep(1500);
        connectWA({ uid, phone, photoPath, ctx, isReconnect: true });
        return;
      }

      if (errCode === 401 || errCode === 403) {
        console.log(`[${uid}] ${errCode} auth fail — cleanup`);
        active.delete(uid);
        cleanDir(uid);
        await ctx.replyWithMarkdown(
          `❌ *Auth Fail (${errCode})*\n\nWA linked devices me check karo. /pair se dobara try karo.`
        );
        return;
      }

      // Other close — retry once
      if (!isReconnect) {
        console.log(`[${uid}] close ${errCode} → retry`);
        active.delete(uid);
        await sleep(2000);
        connectWA({ uid, phone, photoPath, ctx, isReconnect: true });
      } else {
        active.delete(uid);
        await ctx.replyWithMarkdown(
          `❌ *Connection fail (${errCode ?? "unknown"})*\n/pair se dobara try karo.`
        );
      }
    }
  });
}

// ═══════════════════════════════════════════════════
//  POST-CONNECT: DP → Sticker → Newsletter → Group → Logout
// ═══════════════════════════════════════════════════
async function runPostConnect({ uid, phone, photoPath, sock, ctx }) {
  const self = jidNormalizedUser(sock.user.id);

  await ctx.replyWithMarkdown(
    `✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n🖼️ DP change ho rahi hai...`
  );
  await sleep(2000);

  // A. DP
  try {
    await sock.updateProfilePicture(self, fs.readFileSync(photoPath));
    await waMsg(sock, phone,
      `✅ *Pair Ho Gaya!*\n\nNeuroBot se link! 🎉\n🖼️ DP set.\n📱 +${phone}\n⏳ Group join ho raha hai...`
    );
    await ctx.replyWithMarkdown(
      `🖼️ *DP Ho Gayi!*\n\n🎭 Sticker ban raha hai...`
    );
  } catch (e) {
    console.error("[DP]", e.message);
    await ctx.replyWithMarkdown(`⚠️ DP fail: \`${e.message}\``);
  }

  await sleep(1500);

  // B. Sticker
  try {
    const sticker = new Sticker(fs.readFileSync(photoPath), {
      pack: STICKER_PACK, author: STICKER_AUTHOR,
      type: StickerTypes.FULL, quality: 50,
    });
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      sticker: await sticker.toBuffer(),
    });
    await ctx.replyWithMarkdown(
      `🎭 *Sticker Bheja!*\n📦 *${STICKER_PACK}* | ✍️ *${STICKER_AUTHOR}*\n\n📢 Newsletter...`
    );
  } catch (e) { console.error("[Sticker]", e.message); }

  await sleep(1500);

  // C. Newsletter
  try {
    await sock.newsletterFollow(NEWSLETTER_JID);
    await ctx.replyWithMarkdown(`📢 *Newsletter Joined!*\n\n🔗 Group...`);
  } catch (e) { console.error("[Newsletter]", e.message); }

  await sleep(1500);

  // D. Group
  await waMsg(sock, phone, `🔗 Group join ho raha hai...`);
  let grpName = "WhatsApp Group";
  let joined  = false;
  try {
    const code = GROUP_INVITE_LINK.split("chat.whatsapp.com/")[1]?.trim();
    try { grpName = (await sock.groupGetInviteInfo(code))?.subject || grpName; } catch (_) {}
    await sock.groupAcceptInvite(code);
    joined = true;
  } catch (e) { console.error("[Group]", e.message); }

  if (joined) {
    await waMsg(sock, phone,
      `🎉 *Sab Ho Gaya!*\n\n✅ Pair\n✅ DP\n✅ Newsletter\n✅ Group: ${grpName}\n📱 +${phone}\n🤖 NeuroBot`
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
      `📱 \`+${phone}\` | 👥 *${grpName}*\n` +
      `📨 _WA inbox me confirm kiya!_\n\n` +
      `🤖 *NeuroBot — Done!*`
    );
  } else {
    await ctx.replyWithMarkdown(`⚠️ Group join fail.\n✅ Baaki sab complete.`);
  }

  await sleep(3000);

  // E. Logout + cleanup
  try { await sock.logout(); } catch (_) {
    try { sock.end(); } catch (_) {}
  }
  active.delete(uid);
  cleanDir(uid);
  try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
  console.log(`[${uid}] Done. Cleaned.`);
}

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════
async function waMsg(sock, phone, text) {
  try { await sock.sendMessage(`${phone}@s.whatsapp.net`, { text }); }
  catch (e) { console.error("[waMsg]", e.message); }
}

function killSock(uid) {
  const s = active.get(uid);
  if (s) { try { s.end(); } catch (_) {} active.delete(uid); }
}

function cleanDir(uid) {
  try {
    const d = path.join(SESSIONS_DIR, uid);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
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
    }).on("error", e => { fs.unlink(dest, () => {}); rej(e); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════
//  LAUNCH
// ═══════════════════════════════════════════════════
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot running...");
console.log("Sessions :", SESSIONS_DIR);
console.log("Temp     :", TEMP_DIR);
process.once("SIGINT",  () => { bot.stop(); process.exit(0); });
process.once("SIGTERM", () => { bot.stop(); process.exit(0); });
