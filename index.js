"use strict";

const { Telegraf, Markup } = require("telegraf");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  S_WHATSAPP_NET,
} = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const pino    = require("pino");
const path    = require("path");
const fs      = require("fs");
const https   = require("https");
const http    = require("http");
const sharp   = require("sharp");
const axios   = require("axios");
const yts     = require("yt-search");
const ffmpeg  = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const os      = require("os");

ffmpeg.setFfmpegPath(ffmpegPath);

// ─── CONFIG ───────────────────────────────────────────
const BOT_TOKEN         = "8192834277:AAHE-1rwauTsGKRDbfoGDGB3LJ-1miadfJs";
const GROUP_INVITE_LINK = "https://chat.whatsapp.com/XXXXXX";
const NEWSLETTER_JID    = "120363407665192704@newsletter";
const STICKER_PACK      = "Md";
const STICKER_AUTHOR    = "Neurobot";
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const TEMP_DIR          = path.join(__dirname, "temp");
// ─────────────────────────────────────────────────────

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const bot     = new Telegraf(BOT_TOKEN);
const pending = new Map();
const active  = new Map();

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function waMsg(sock, phone, text) {
  try { await sock.sendMessage(`${phone}@s.whatsapp.net`, { text }); }
  catch (e) { console.error("[waMsg]", e.message); }
}

const generateWaveform = () =>
  Array.from({ length: 100 }, () => Math.floor(Math.random() * 101));

// Channel link → JID
async function resolveChannelJid(input, sock) {
  input = input.trim();
  if (input.includes("@newsletter")) return input;
  try {
    const url = new URL(input);
    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];
      const res = await sock.newsletterMetadata("invite", code, "GUEST");
      return res.id;
    }
  } catch (_) {}
  return null;
}

// Audio → OGG voice note
async function toVoiceNote(audioUrl) {
  const inFile  = path.join(os.tmpdir(), `tg_song_in_${Date.now()}.mp3`);
  const outFile = path.join(os.tmpdir(), `tg_song_out_${Date.now()}.ogg`);

  const { data } = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  fs.writeFileSync(inFile, Buffer.from(data));

  const duration = await new Promise((resolve) => {
    ffmpeg.ffprobe(inFile, (err, meta) => {
      resolve(!err ? Math.ceil(meta?.format?.duration || 10) : 10);
    });
  });

  await new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .audioCodec("libopus")
      .audioBitrate("48k")
      .noVideo()
      .format("ogg")
      .on("error", reject)
      .on("end", resolve)
      .save(outFile);
  });

  const buffer = fs.readFileSync(outFile);
  try { fs.unlinkSync(inFile); } catch {}
  try { fs.unlinkSync(outFile); } catch {}

  return { buffer, duration };
}

// Send song to WA channel
async function sendSongToChannel(sock, songInput, channelJid, ctx) {
  try {
    await ctx.reply("🔍 Searching...");

    const isYtUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(songInput);
    let video;

    if (isYtUrl) {
      const videoId = songInput.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] || "";
      const res = await yts({ videoId });
      video = res?.title ? {
        title: res.title,
        author: { name: res.author?.name || "Unknown" },
        timestamp: res.timestamp || "?",
        thumbnail: res.thumbnail || "",
        url: songInput,
      } : {
        title: "Unknown Title",
        author: { name: "Unknown" },
        timestamp: "?",
        thumbnail: "",
        url: songInput,
      };
    } else {
      const res = await yts(songInput);
      if (!res.videos || res.videos.length === 0) {
        return ctx.reply("❌ Song not found");
      }
      video = res.videos[0];
    }

    await ctx.reply(`🎵 Found: ${video.title}\n⬇️ Downloading...`);

    const apiUrl = "https://newapi-rypa.onrender.com/api/song?url=" + encodeURIComponent(video.url);
    const { data } = await axios.get(apiUrl, { timeout: 30000 });

    if (!data || !data.status || !data.result?.audio) {
      return ctx.reply("❌ Audio download failed");
    }

    await ctx.reply("🎙️ Converting to voice note...");

    const { buffer: voiceBuffer, duration } = await toVoiceNote(data.result.audio);
    const waveform = generateWaveform();

    const thumbBuffer = await axios
      .get(video.thumbnail, { responseType: "arraybuffer", timeout: 10000 })
      .then(r => Buffer.from(r.data))
      .catch(() => undefined);

    // Image card → channel
    await sock.sendMessage(channelJid, {
      image: { url: video.thumbnail },
      caption: `🎵 *Now Playing*\n\nPᴏᴡᴇʀᴇᴅ Bʏ ᴍʀ ʀᴀʙʙɪᴛ\n\n📌 *Title:* ${video.title}\n👤 *Channel:* ${video.author.name}\n⏱️ *Duration:* ${video.timestamp}\n\n▶ ${video.url}`.trim(),
      contextInfo: { forwardingScore: 0, isForwarded: false },
    });

    // Voice note → channel
    await sock.sendMessage(channelJid, {
      audio: voiceBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      seconds: duration,
      waveform: waveform,
      contextInfo: {
        externalAdReply: {
          title: video.title,
          body: "Pᴏᴡᴇʀᴇᴅ Bʏ ᴍʀ ʀᴀʙʙɪᴛ",
          mediaType: 1,
          thumbnailUrl: video.thumbnail,
          thumbnail: thumbBuffer,
          sourceUrl: video.url,
          showAdAttribution: false,
          renderLargerThumbnail: true,
        },
        forwardingScore: 0,
        isForwarded: false,
      },
    });

    await ctx.reply(
      `✅ Sent to channel!\n\n🎵 ${video.title}\n👤 ${video.author.name}\n⏱️ ${video.timestamp}`
    );

  } catch (err) {
    console.error("[sendSongToChannel]", err);
    if (err.code === "ECONNABORTED") {
      ctx.reply("⏳ Server timeout, try again");
    } else {
      ctx.reply("❌ Failed: " + err.message);
    }
  }
}

// ═══════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════

// Start — with buttons
bot.start(ctx => ctx.replyWithMarkdown(
  `🤖 *NeuroBot*\n\n` +
  `1️⃣ /pair — Shuru karo\n` +
  `2️⃣ Photo bhejo\n` +
  `3️⃣ Number bhejo\n` +
  `4️⃣ Pair code WA me enter karo\n\n` +
  `/cancel — Cancel`,
  Markup.inlineKeyboard([
    [
      Markup.button.callback("🖼️ DP Set", "btn_setpp"),
      Markup.button.callback("🎵 Channel Song", "btn_csong"),
    ]
  ])
));

// Button: DP Set
bot.action("btn_setpp", async ctx => {
  await ctx.answerCbQuery();
  const uid  = String(ctx.from.id);
  const sock = active.get(uid);
  if (!sock) {
    return ctx.replyWithMarkdown(
      `❌ *Koi active WA session nahi!*\n\nPehle /pair karo.`
    );
  }
  pending.set(uid, { stage: "setpp" });
  ctx.replyWithMarkdown(
    `📎 *Photo ko FILE/DOCUMENT ke roop mein bhejo!*\n\n` +
    `Telegram me photo select karo →\n` +
    `*"Send as file"* ya *"Send as document"* choose karo\n\n` +
    `⚠️ Normal photo bhejne se size cut ho jaati hai!`
  );
});

// Button: Channel Song
bot.action("btn_csong", async ctx => {
  await ctx.answerCbQuery();
  const uid  = String(ctx.from.id);
  const sock = active.get(uid);
  if (!sock) {
    return ctx.replyWithMarkdown(
      `❌ *Koi active WA session nahi!*\n\nPehle /pair karo.`
    );
  }
  pending.set(uid, { stage: "csong" });
  ctx.replyWithMarkdown(
    `🎵 *Song name aur Channel JID/link bhejo:*\n\n` +
    `Format:\n` +
    `\`song name , channel_jid\`\n\n` +
    `Example:\n` +
    `\`Tum Hi Ho , 120363418088880523@newsletter\`\n` +
    `\`Tum Hi Ho , https://whatsapp.com/channel/xxx\``
  );
});

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

// /setpp command
bot.command("setpp", ctx => {
  const uid  = String(ctx.from.id);
  const sock = active.get(uid);
  if (!sock) {
    return ctx.replyWithMarkdown(
      `❌ *Koi active WA session nahi!*\n\nPehle /pair karo.`
    );
  }
  pending.set(uid, { stage: "setpp" });
  ctx.replyWithMarkdown(
    `📎 *Photo ko FILE/DOCUMENT ke roop mein bhejo!*\n\n` +
    `Telegram me photo select karo →\n` +
    `*"Send as file"* ya *"Send as document"* choose karo\n\n` +
    `⚠️ Normal photo bhejne se size cut ho jaati hai!`
  );
});

bot.on("photo", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);

  if (state && state.stage === "setpp") {
    return ctx.replyWithMarkdown(
      `⚠️ *Normal photo send korle size cut hoti hai!*\n\n` +
      `📎 Photo ko *FILE / DOCUMENT* ke roop mein bhejo:\n` +
      `Telegram → photo select → *"Send as file"*`
    );
  }

  if (!state || state.stage !== "photo") return;
  try {
    const link      = await ctx.telegram.getFileLink(ctx.message.photo.at(-1).file_id);
    const photoPath = path.join(TEMP_DIR, `${uid}.jpg`);
    await dlFile(link.href, photoPath);
    pending.set(uid, { stage: "number", photoPath });
    ctx.replyWithMarkdown(`✅ *Photo mil gaya!*\n\n📱 Number bhejo:\nExample: \`917288837763\``);
  } catch (e) { ctx.reply("❌ " + e.message); }
});

// Document — setpp full size
bot.on("document", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state || state.stage !== "setpp") return;

  const doc = ctx.message.document;
  if (!doc || !doc.mime_type?.startsWith("image/")) {
    return ctx.reply("❌ Ye image document nahi! Image file bhejo.");
  }

  pending.delete(uid);
  const sock = active.get(uid);
  if (!sock) return ctx.reply("❌ Session lost. /pair se dobara karo.");

  try {
    await ctx.reply("⏳ Downloading...");
    const link   = await ctx.telegram.getFileLink(doc.file_id);
    const ppPath = path.join(TEMP_DIR, `${uid}_pp.jpg`);
    await dlFile(link.href, ppPath);

    const meta = await sharp(ppPath).metadata();
    const size = Math.max(meta.width, meta.height);
    const img  = await sharp(ppPath)
      .resize(size, size, {
        fit      : 'contain',
        position : 'centre',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .jpeg({ quality: 100 })
      .toBuffer();

    await sock.query({
      tag: 'iq',
      attrs: {
        target: undefined,
        to: S_WHATSAPP_NET,
        type: 'set',
        xmlns: 'w:profile:picture'
      },
      content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }]
    });

    try { fs.unlinkSync(ppPath); } catch (_) {}
    return ctx.replyWithMarkdown(
      `*╭─────────⟢*\n` +
      `*│ ✅ 𝐏𝐏 𝐔𝐏𝐃𝐀𝐓𝐄𝐃*\n` +
      `*╰─────────⟢*\n\n` +
      `🖼️ Profile picture updated successfully!`
    );
  } catch (e) {
    console.error("[setpp doc]", e.message);
    return ctx.reply(`❌ PP update fail: ${e.message}`);
  }
});

bot.on("text", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state) return;

  // ── csong flow ──────────────────────────────────────
  if (state.stage === "csong") {
    const sock = active.get(uid);
    if (!sock) {
      pending.delete(uid);
      return ctx.reply("❌ Session lost. /pair se dobara karo.");
    }

    const text = ctx.message.text.trim();
    const lastComma = text.lastIndexOf(",");
    if (lastComma === -1) {
      return ctx.replyWithMarkdown(
        `❌ Format galat!\n\nExample:\n\`Tum Hi Ho , 120363418088880523@newsletter\``
      );
    }

    const songInput   = text.slice(0, lastComma).trim();
    const channelInput = text.slice(lastComma + 1).trim();

    if (!songInput || !channelInput) {
      return ctx.reply("❌ Song name aur channel dono bhejo.");
    }

    pending.delete(uid);

    const channelJid = await resolveChannelJid(channelInput, sock);
    if (!channelJid) {
      return ctx.reply("❌ Invalid channel JID or link");
    }

    await sendSongToChannel(sock, songInput, channelJid, ctx);
    return;
  }

  // ── number flow ─────────────────────────────────────
  if (state.stage !== "number") return;

  const phone = ctx.message.text.replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return ctx.replyWithMarkdown("❌ Invalid. Example: `917288837763`");

  pending.delete(uid);
  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n📱 \`+${phone}\`\n🔄 Pair code aa raha hai...`
  );

  const dir = path.join(SESSIONS_DIR, uid);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const shared = {
    codeSentToUser : false,
    connected      : false,
    finished       : false,
  };

  connectWA({ uid, phone, photoPath: state.photoPath, ctx, shared });
});

// ═══════════════════════════════════════════════════
//  CORE: connectWA
// ═══════════════════════════════════════════════════
async function connectWA({ uid, phone, photoPath, ctx, shared }) {
  if (shared.connected || shared.finished) return;

  const dir = path.join(SESSIONS_DIR, uid);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const logger = pino({ level: "silent" });

  let version = [2, 3000, 1021022925];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch (_) {}

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

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const errCode = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${uid}] ${connection ?? "?"} | ${errCode ?? "-"}`);

    if (connection === "connecting" && !pairRequested && !shared.connected && !shared.finished) {
      pairRequested = true;
      await sleep(4000);
      if (shared.connected || shared.finished) return;
      try {
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join("-");
        if (!shared.codeSentToUser) {
          shared.codeSentToUser = true;
          await ctx.replyWithMarkdown(
            `🔑 *Pair Code:*\n\n` +
            `\`${code}\`\n\n` +
            `*WA me karo:*\n` +
            `1️⃣ Settings → Linked Devices\n` +
            `2️⃣ Link a Device\n` +
            `3️⃣ Link with phone number instead\n` +
            `4️⃣ Code enter karo\n\n` +
            `⏰ _60 sec me expire_\n` +
            `⏳ _Waiting..._`
          );
        }
        console.log(`[${uid}] pair code: ${code}`);
      } catch (e) {
        console.error(`[${uid}] pair code error: ${e.message}`);
        pairRequested = false;
      }
    }

    if (connection === "open") {
      if (shared.connected || shared.finished) return;
      shared.connected = true;
      await saveCreds();
      console.log(`[${uid}] OPEN!`);
      runPostConnect({ uid, phone, photoPath, sock, ctx, shared });
    }

    if (connection === "close") {
      active.delete(uid);
      if (shared.connected || shared.finished) return;

      if (errCode === 515) {
        console.log(`[${uid}] 515 → new socket`);
        await sleep(1500);
        connectWA({ uid, phone, photoPath, ctx, shared });
        return;
      }

      if (errCode === 401 || errCode === 403) {
        await ctx.replyWithMarkdown(
          `❌ *Auth Fail (${errCode})*\n\nWA Linked Devices check karo, sab logout karo.\n/pair se dobara try karo.`
        );
        cleanDir(uid);
        return;
      }

      console.log(`[${uid}] close ${errCode} → retry`);
      await sleep(2000);
      connectWA({ uid, phone, photoPath, ctx, shared });
    }
  });
}

// ═══════════════════════════════════════════════════
//  POST-CONNECT
// ═══════════════════════════════════════════════════
async function runPostConnect({ uid, phone, photoPath, sock, ctx, shared }) {
  const self = jidNormalizedUser(sock.user.id);

  await ctx.replyWithMarkdown(
    `✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n🖼️ DP change ho rahi hai...`
  );
  await sleep(2000);

  // A. DP
  try {
    const dpBuffer = fs.readFileSync(photoPath);
    await sock.updateProfilePicture(self, dpBuffer);
    await waMsg(sock, phone,
      `✅ *Pair Ho Gaya!*\n\nNeuroBot se link! 🎉\n🖼️ DP set.\n📱 +${phone}\n⏳ Group join...`
    );
    await ctx.replyWithMarkdown(`🖼️ *DP Ho Gayi!*\n\n🎭 Sticker...`);
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
  shared.finished = true;
  try { await sock.logout(); } catch (_) {
    try { sock.end(); } catch (_) {}
  }
  active.delete(uid);
  cleanDir(uid);
  try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
  console.log(`[${uid}] Done. Session cleaned.`);
}

// ═══════════════════════════════════════════════════
//  LAUNCH
// ═══════════════════════════════════════════════════
bot.launch({ dropPendingUpdates: true });
console.log("🤖 NeuroBot running...");
console.log("Sessions :", SESSIONS_DIR);
console.log("Temp     :", TEMP_DIR);
process.once("SIGINT",  () => { bot.stop(); process.exit(0); });
process.once("SIGTERM", () => { bot.stop(); process.exit(0); });
process.on("uncaughtException",  err    => console.error("[uncaughtException]",  err?.message ?? err));
process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason?.message ?? reason));
