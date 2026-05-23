"use strict";

const { Telegraf, Markup } = require("telegraf");
const pino       = require("pino");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const http       = require("http");
const sharp      = require("sharp");
const axios      = require("axios");
const yts        = require("yt-search");
const ffmpeg     = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const os         = require("os");

// ─── gifted-baileys (CommonJS) ───────────────────────
let makeWASocket, useMultiFileAuthState, Browsers, jidNormalizedUser, S_WHATSAPP_NET;
try {
  const gb          = require("gifted-baileys");
  makeWASocket      = gb.default;
  useMultiFileAuthState = gb.useMultiFileAuthState;
  Browsers          = gb.Browsers;
  jidNormalizedUser = gb.jidNormalizedUser || ((jid) => jid.split(":")[0] + "@s.whatsapp.net");
  S_WHATSAPP_NET    = gb.S_WHATSAPP_NET    || "s.whatsapp.net";
} catch (e) {
  console.error("❌ gifted-baileys load failed:", e.message);
  process.exit(1);
}

// ─── wa-sticker-formatter (ESM) — loaded at startup ──
let Sticker, StickerTypes;

ffmpeg.setFfmpegPath(ffmpegPath);

// ─── CONFIG ───────────────────────────────────────────
const BOT_TOKEN         = "7931485189:AAEEP1WVW2nRiHJeKt9hWdZfQHBLJapt_eI";
const GROUP_INVITE_LINK = "https://chat.whatsapp.com/XXXXXX";
const NEWSLETTER_JID    = "120363407665192704@newsletter";
const STICKER_PACK      = "Md";
const STICKER_AUTHOR    = "Neurobot";
const SESSIONS_DIR      = path.join(__dirname, "sessions");
const TEMP_DIR          = path.join(__dirname, "temp");
// ─────────────────────────────────────────────────────

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const bot     = new Telegraf(BOT_TOKEN);
const pending = new Map(); // uid → state
const active  = new Map(); // `${uid}_${cmdType}` → sock

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function activeKey(uid, cmdType) { return `${uid}_${cmdType}`; }

function killSock(uid, cmdType) {
  const key = activeKey(uid, cmdType);
  const s   = active.get(key);
  if (s) { try { s.end(); } catch (_) {} active.delete(key); }
}

function killAllSocks(uid) {
  for (const [key, sock] of active.entries()) {
    if (key.startsWith(`${uid}_`)) {
      try { sock.end(); } catch (_) {}
      active.delete(key);
    }
  }
}

function cleanDir(uid, cmdType) {
  try {
    const d = path.join(SESSIONS_DIR, `${uid}_${cmdType}`);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}

function dlFile(url, dest) {
  return new Promise((res, rej) => {
    const proto = url.startsWith("https") ? https : http;
    const f     = fs.createWriteStream(dest);
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

async function resolveChannelJid(input, sock) {
  input = input.trim();
  if (input.includes("@newsletter")) return input;
  try {
    const url = new URL(input);
    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];
      const res  = await sock.newsletterMetadata("invite", code, "GUEST");
      return res.id;
    }
  } catch (_) {}
  return null;
}

async function toVoiceNote(audioUrl) {
  const inFile  = path.join(os.tmpdir(), `tg_song_in_${Date.now()}.mp3`);
  const outFile = path.join(os.tmpdir(), `tg_song_out_${Date.now()}.ogg`);

  const { data } = await axios.get(audioUrl, { responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(inFile, Buffer.from(data));

  const duration = await new Promise(resolve => {
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
      .on("end",   resolve)
      .save(outFile);
  });

  const buffer = fs.readFileSync(outFile);
  try { fs.unlinkSync(inFile);  } catch (_) {}
  try { fs.unlinkSync(outFile); } catch (_) {}
  return { buffer, duration };
}

async function finishSession({ uid, cmdType, sock, shared, photoPath }) {
  shared.finished = true;
  try { await sock.logout(); } catch (_) {
    try { sock.end(); } catch (_) {}
  }
  active.delete(activeKey(uid, cmdType));
  cleanDir(uid, cmdType);
  if (photoPath) {
    try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
  }
  console.log(`[${uid}:${cmdType}] ✅ Done. Session cleaned.`);
}

// ═══════════════════════════════════════════════════
//  SEND SONG TO CHANNEL
// ═══════════════════════════════════════════════════
async function sendSongToChannel(sock, songInput, channelJid, ctx) {
  try {
    await ctx.reply("🔍 Searching...");

    const isYtUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(songInput);
    let video;

    if (isYtUrl) {
      const videoId = songInput.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] || "";
      const res     = await yts({ videoId });
      video = res?.title ? {
        title: res.title,
        author: { name: res.author?.name || "Unknown" },
        timestamp: res.timestamp || "?",
        thumbnail: res.thumbnail || "",
        url: songInput,
      } : { title: "Unknown Title", author: { name: "Unknown" }, timestamp: "?", thumbnail: "", url: songInput };
    } else {
      const res = await yts(songInput);
      if (!res.videos || res.videos.length === 0) return ctx.reply("❌ Song not found");
      video = res.videos[0];
    }

    await ctx.reply(`🎵 Found: ${video.title}\n⬇️ Downloading...`);

    const apiUrl    = "https://newapi-rypa.onrender.com/api/song?url=" + encodeURIComponent(video.url);
    const { data }  = await axios.get(apiUrl, { timeout: 30000 });
    if (!data || !data.status || !data.result?.audio) return ctx.reply("❌ Audio download failed");

    await ctx.reply("🎙️ Converting to voice note...");
    const { buffer: voiceBuffer, duration } = await toVoiceNote(data.result.audio);
    const waveform = generateWaveform();

    const thumbBuffer = await axios
      .get(video.thumbnail, { responseType: "arraybuffer", timeout: 10000 })
      .then(r => Buffer.from(r.data))
      .catch(() => undefined);

    await sock.sendMessage(channelJid, {
      image: { url: video.thumbnail },
      caption: `🎵 *Now Playing*\n\nPᴏᴡᴇʀᴇᴅ Bʏ ɴᴇᴜʀᴏʙᴏᴛ\n\n📌 *Title:* ${video.title}\n👤 *Channel:* ${video.author.name}\n⏱️ *Duration:* ${video.timestamp}\n\n▶ ${video.url}`.trim(),
      contextInfo: { forwardingScore: 0, isForwarded: false },
    });

    await sock.sendMessage(channelJid, {
      audio:    voiceBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt:      true,
      seconds:  duration,
      waveform: waveform,
      contextInfo: {
        externalAdReply: {
          title: video.title,
          body: "Pᴏᴡᴇʀᴇᴅ Bʏ ɴᴇᴜʀᴏʙᴏᴛ",
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

    await ctx.reply(`✅ Sent to channel!\n\n🎵 ${video.title}\n👤 ${video.author.name}\n⏱️ ${video.timestamp}`);

  } catch (err) {
    console.error("[sendSongToChannel]", err);
    ctx.reply(err.code === "ECONNABORTED" ? "⏳ Server timeout, try again" : "❌ Failed: " + err.message);
  }
}

// ═══════════════════════════════════════════════════
//  SEND GROUP STATUS
// ═══════════════════════════════════════════════════
async function sendGroupStatus(sock, statusType, statusContent, groupJid, caption, ctx) {
  try {
    await ctx.reply("📤 Sending group status...");
    let msgPayload;

    switch (statusType) {
      case "image":
        msgPayload = { groupStatusMessage: { image: { url: statusContent }, caption: caption || "" } };
        break;
      case "video":
        msgPayload = { groupStatusMessage: { video: { url: statusContent }, caption: caption || "" } };
        break;
      case "audio":
        msgPayload = { groupStatusMessage: { audio: { url: statusContent }, mimetype: "audio/mp4", ptt: true } };
        break;
      case "text": {
        const [txt, bgColor, font] = statusContent.split("|");
        msgPayload = {
          groupStatusMessage: {
            text: txt || statusContent,
            backgroundColor: bgColor || "#000000",
            font: parseInt(font) || 0,
          }
        };
        break;
      }
      default:
        return ctx.reply("❌ Invalid status type");
    }

    await sock.sendMessage(groupJid, msgPayload);

    await ctx.replyWithMarkdown(
      `*╭──────────────⟢*\n` +
      `*│ ✅ 𝐆𝐑𝐎𝐔𝐏 𝐒𝐓𝐀𝐓𝐔𝐒 𝐒𝐄𝐍𝐓*\n` +
      `*╰──────────────⟢*\n\n` +
      `📊 Type: *${statusType}*\n` +
      `👥 Group: \`${groupJid}\``
    );
  } catch (err) {
    console.error("[sendGroupStatus]", err);
    ctx.reply("❌ Group status fail: " + err.message);
  }
}

// ═══════════════════════════════════════════════════
//  TELEGRAM — MENU
// ═══════════════════════════════════════════════════

bot.start(ctx => ctx.replyWithMarkdown(
  `🤖 *NeuroBot*\n\n` +
  `Ek command choose karo — *har command ke liye alag pairing hogi:*\n\n` +
  `🔗 /pair — Full pair _(DP + Sticker + Newsletter + Group)_\n` +
  `🖼️ DP Set — Sirf DP change karo\n` +
  `🎵 Channel Song — WA Channel me song bhejo\n` +
  `📊 Group Status — WA Group me status bhejo\n\n` +
  `/cancel — Cancel karo`,
  Markup.inlineKeyboard([
    [
      Markup.button.callback("🖼️ DP Set",       "btn_setpp"),
      Markup.button.callback("🎵 Channel Song", "btn_csong"),
    ],
    [
      Markup.button.callback("📊 Group Status", "btn_gstatus"),
    ]
  ])
));

// ═══════════════════════════════════════════════════
//  BUTTON ACTIONS
// ═══════════════════════════════════════════════════

// ── DP SET ──────────────────────────────────────────
bot.action("btn_setpp", async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  killAllSocks(uid);
  pending.set(uid, { stage: "setpp_photo", cmdType: "setpp" });
  ctx.replyWithMarkdown(
    `🖼️ *DP Set — Alag Pairing Hogi*\n\n` +
    `📎 Photo ko *FILE / DOCUMENT* ke roop mein bhejo:\n` +
    `Telegram → photo select → *"Send as file"*\n\n` +
    `⚠️ Normal photo bhejne se size cut ho jaati hai!`
  );
});

// ── CHANNEL SONG ────────────────────────────────────
bot.action("btn_csong", async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  killAllSocks(uid);
  pending.set(uid, { stage: "csong_input", cmdType: "csong" });
  ctx.replyWithMarkdown(
    `🎵 *Channel Song — Alag Pairing Hogi*\n\n` +
    `Song name aur Channel JID/link bhejo:\n\n` +
    `Format:\n\`song name , channel_jid\`\n\n` +
    `Example:\n` +
    `\`Tum Hi Ho , 120363418088880523@newsletter\`\n` +
    `\`Tum Hi Ho , https://whatsapp.com/channel/xxx\`\n\n` +
    `_(Baad mein phone number maanga jaega)_`
  );
});

// ── GROUP STATUS ────────────────────────────────────
bot.action("btn_gstatus", async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  killAllSocks(uid);
  pending.set(uid, { stage: "gstatus_type", cmdType: "gstatus" });
  ctx.replyWithMarkdown(
    `📊 *Group Status — Alag Pairing Hogi*\n\nStatus ka type choose karo:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🖼️ Image", "gstatus_image"),
        Markup.button.callback("🎬 Video", "gstatus_video"),
      ],
      [
        Markup.button.callback("🎵 Audio", "gstatus_audio"),
        Markup.button.callback("✏️ Text",  "gstatus_text"),
      ]
    ])
  );
});

// ── GROUP STATUS TYPE ────────────────────────────────
const STATUS_INSTRUCTIONS = {
  image: `🖼️ *Image Status*\n\nFormat:\n\`image_url , group_jid\`\n\nCaption optional:\n\`image_url , group_jid , caption\`\n\nExample:\n\`https://example.com/img.jpg , 120363419778858313@g.us , My status!\``,
  video: `🎬 *Video Status*\n\nFormat:\n\`video_url , group_jid\`\n\nCaption optional:\n\`video_url , group_jid , caption\``,
  audio: `🎵 *Audio Status*\n\nFormat:\n\`audio_url , group_jid\`\n\nExample:\n\`https://example.com/audio.mp3 , 120363419778858313@g.us\``,
  text:  `✏️ *Text Status*\n\nFormat:\n\`text|bgColor|font , group_jid\`\n\nExample:\n\`Hello World!|#FF5733|1 , 120363419778858313@g.us\`\n\n_bgColor = hex • font = 0~5_`,
};

["image", "video", "audio", "text"].forEach(type => {
  bot.action(`gstatus_${type}`, async ctx => {
    await ctx.answerCbQuery();
    const uid   = String(ctx.from.id);
    const state = pending.get(uid);
    if (!state || state.cmdType !== "gstatus") return;
    pending.set(uid, { ...state, stage: "gstatus_input", statusType: type });
    ctx.replyWithMarkdown(STATUS_INSTRUCTIONS[type] + `\n\n_(Baad mein phone number maanga jaega)_`);
  });
});

// ── /pair COMMAND ────────────────────────────────────
bot.command("pair", ctx => {
  const uid = String(ctx.from.id);
  killAllSocks(uid);
  pending.set(uid, { stage: "pair_photo", cmdType: "pair" });
  ctx.replyWithMarkdown(
    `🔗 *Full Pair — Alag Pairing*\n\n` +
    `📎 Photo ko *FILE / DOCUMENT* ke roop mein bhejo\n\n` +
    `_(Photo → Number → Code → DP + Sticker + Newsletter + Group)_`
  );
});

bot.command("cancel", ctx => {
  const uid = String(ctx.from.id);
  killAllSocks(uid);
  pending.delete(uid);
  ctx.reply("❌ Cancel. /start se dobara karo.");
});

// ═══════════════════════════════════════════════════
//  MEDIA HANDLERS
// ═══════════════════════════════════════════════════

bot.on("photo", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state) return;
  const { stage } = state;
  if (stage === "pair_photo" || stage === "setpp_photo") {
    ctx.replyWithMarkdown(
      `⚠️ *Normal photo se size cut hoti hai!*\n\n` +
      `📎 Photo ko *FILE / DOCUMENT* ke roop mein bhejo:\n` +
      `Telegram → photo select → *"Send as file"*`
    );
  }
});

bot.on("document", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state) return;

  const { stage, cmdType } = state;
  const doc = ctx.message.document;

  if (!doc || !doc.mime_type?.startsWith("image/")) {
    return ctx.reply("❌ Ye image document nahi! Image file bhejo.");
  }

  if (stage === "pair_photo" || stage === "setpp_photo") {
    try {
      await ctx.reply("⏳ Photo downloading...");
      const link      = await ctx.telegram.getFileLink(doc.file_id);
      const photoPath = path.join(TEMP_DIR, `${uid}_${cmdType}.jpg`);
      await dlFile(link.href, photoPath);

      const nextStage = stage === "pair_photo" ? "pair_number" : "setpp_number";
      pending.set(uid, { ...state, stage: nextStage, photoPath });
      ctx.replyWithMarkdown(`✅ *Photo mil gaya!*\n\n📱 Number bhejo:\nExample: \`917288837763\``);
    } catch (e) { ctx.reply("❌ " + e.message); }
  }
});

// ═══════════════════════════════════════════════════
//  TEXT HANDLER
// ═══════════════════════════════════════════════════

bot.on("text", async ctx => {
  const uid   = String(ctx.from.id);
  const state = pending.get(uid);
  if (!state) return;

  const { stage, cmdType } = state;
  const text = ctx.message.text.trim();

  // ── csong: collect song + channel ───────────────
  if (stage === "csong_input") {
    const lastComma = text.lastIndexOf(",");
    if (lastComma === -1)
      return ctx.replyWithMarkdown(`❌ Format galat!\n\nExample:\n\`Tum Hi Ho , 120363418088880523@newsletter\``);

    const songInput    = text.slice(0, lastComma).trim();
    const channelInput = text.slice(lastComma + 1).trim();
    if (!songInput || !channelInput) return ctx.reply("❌ Song name aur channel dono bhejo.");

    pending.set(uid, { ...state, stage: "csong_number", songInput, channelInput });
    ctx.replyWithMarkdown(`✅ *Song & Channel mile!*\n\n📱 Number bhejo:\nExample: \`917288837763\``);
    return;
  }

  // ── gstatus: collect content + group jid ────────
  if (stage === "gstatus_input") {
    const parts = text.split(",").map(p => p.trim());
    if (parts.length < 2) return ctx.reply("❌ Format galat! Content aur Group JID dono bhejo.");

    const statusContent = parts[0];
    const groupJid      = parts[1];
    const caption       = parts[2] || "";

    if (!groupJid.includes("@g.us"))
      return ctx.reply("❌ Group JID galat!\nFormat: `120363419778858313@g.us`");

    pending.set(uid, { ...state, stage: "gstatus_number", statusContent, groupJid, caption });
    ctx.replyWithMarkdown(`✅ *Status info mila!*\n\n📱 Number bhejo:\nExample: \`917288837763\``);
    return;
  }

  // ── number input ─────────────────────────────────
  const isNumberStage = [
    "pair_number", "setpp_number", "csong_number", "gstatus_number"
  ].includes(stage);
  if (!isNumberStage) return;

  const phone = text.replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return ctx.replyWithMarkdown("❌ Invalid. Example: `917288837763`");

  const savedState = { ...state };
  pending.delete(uid);

  await ctx.replyWithMarkdown(
    `⏳ *Processing...*\n📱 \`+${phone}\`\n🔄 Pair code aa raha hai...\n\n` +
    `_Command: ${cmdType.toUpperCase()}_`
  );

  const dir = path.join(SESSIONS_DIR, `${uid}_${cmdType}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const shared = { codeSentToUser: false, connected: false, finished: false };
  connectWA({ uid, phone, state: savedState, ctx, shared });
});

// ═══════════════════════════════════════════════════
//  CORE: connectWA
// ═══════════════════════════════════════════════════
async function connectWA({ uid, phone, state, ctx, shared }) {
  if (shared.connected || shared.finished) return;

  const { cmdType } = state;
  const dir = path.join(SESSIONS_DIR, `${uid}_${cmdType}`);
  fs.mkdirSync(dir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    auth:                authState,
    browser:             Browsers.ubuntu("NeuroBot"),
    printQRInTerminal:   false,
    syncFullHistory:     false,
    markOnlineOnConnect: false,
    connectTimeoutMs:    60_000,
    keepAliveIntervalMs: 25_000,
    logger,
  });

  active.set(activeKey(uid, cmdType), sock);
  sock.ev.on("creds.update", saveCreds);

  let pairRequested = false;

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const errCode = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${uid}:${cmdType}] ${connection ?? "?"} | ${errCode ?? "-"}`);

    // ── Request pair code once ──
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
            `🔑 *Pair Code — ${cmdType.toUpperCase()}*\n\n` +
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
        console.log(`[${uid}:${cmdType}] pair code: ${code}`);
      } catch (e) {
        console.error(`[${uid}:${cmdType}] pair code error: ${e.message}`);
        pairRequested = false;
      }
    }

    // ── Connected ──
    if (connection === "open") {
      if (shared.connected || shared.finished) return;
      shared.connected = true;
      await saveCreds();
      console.log(`[${uid}:${cmdType}] OPEN!`);
      runPostConnect({ uid, phone, state, sock, ctx, shared });
    }

    // ── Disconnected ──
    if (connection === "close") {
      active.delete(activeKey(uid, cmdType));
      if (shared.connected || shared.finished) return;

      if (errCode === 515) {
        console.log(`[${uid}:${cmdType}] 515 → new socket`);
        await sleep(1500);
        connectWA({ uid, phone, state, ctx, shared });
        return;
      }
      if (errCode === 401 || errCode === 403) {
        await ctx.replyWithMarkdown(
          `❌ *Auth Fail (${errCode})*\n\nWA Linked Devices check karo, sab logout karo.\n/start se dobara try karo.`
        );
        cleanDir(uid, cmdType);
        return;
      }

      console.log(`[${uid}:${cmdType}] close ${errCode} → retry`);
      await sleep(2000);
      connectWA({ uid, phone, state, ctx, shared });
    }
  });
}

// ═══════════════════════════════════════════════════
//  POST-CONNECT ROUTER
// ═══════════════════════════════════════════════════
async function runPostConnect({ uid, phone, state, sock, ctx, shared }) {
  switch (state.cmdType) {
    case "pair":    return runPairFlow   ({ uid, phone, state, sock, ctx, shared });
    case "setpp":   return runSetppFlow  ({ uid, phone, state, sock, ctx, shared });
    case "csong":   return runCsongFlow  ({ uid, phone, state, sock, ctx, shared });
    case "gstatus": return runGstatusFlow({ uid, phone, state, sock, ctx, shared });
  }
}

// ═══════════════════════════════════════════════════
//  FLOW 1: FULL PAIR
// ═══════════════════════════════════════════════════
async function runPairFlow({ uid, phone, state, sock, ctx, shared }) {
  const self       = jidNormalizedUser(sock.user.id);
  const { photoPath } = state;

  await ctx.replyWithMarkdown(`✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n🖼️ DP change ho rahi hai...`);
  await sleep(2000);

  // A. DP
  try {
    const dpBuffer = fs.readFileSync(photoPath);
    await sock.updateProfilePicture(self, dpBuffer);
    await waMsg(sock, phone, `✅ *Pair Ho Gaya!*\n\nNeuroBot se link! 🎉\n🖼️ DP set.\n📱 +${phone}\n⏳ Group join...`);
    await ctx.replyWithMarkdown(`🖼️ *DP Ho Gayi!*\n\n🎭 Sticker...`);
  } catch (e) {
    console.error("[DP]", e.message);
    await ctx.replyWithMarkdown(`⚠️ DP fail: \`${e.message}\``);
  }
  await sleep(1500);

  // B. Sticker
  try {
    const sticker = new Sticker(fs.readFileSync(photoPath), {
      pack: STICKER_PACK, author: STICKER_AUTHOR, type: StickerTypes.FULL, quality: 50,
    });
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { sticker: await sticker.toBuffer() });
    await ctx.replyWithMarkdown(`🎭 *Sticker Bheja!*\n📦 *${STICKER_PACK}* | ✍️ *${STICKER_AUTHOR}*\n\n📢 Newsletter...`);
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
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📱 \`+${phone}\` | 👥 *${grpName}*\n` +
      `📨 _WA inbox me confirm kiya!_\n\n` +
      `🤖 *NeuroBot — Done!*`
    );
  } else {
    await ctx.replyWithMarkdown(`⚠️ Group join fail.\n✅ Baaki sab complete.`);
  }

  await sleep(3000);
  await finishSession({ uid, cmdType: "pair", sock, shared, photoPath });
}

// ═══════════════════════════════════════════════════
//  FLOW 2: DP SET
// ═══════════════════════════════════════════════════
async function runSetppFlow({ uid, phone, state, sock, ctx, shared }) {
  const { photoPath } = state;

  await ctx.replyWithMarkdown(`✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n🖼️ DP change ho rahi hai...`);
  await sleep(2000);

  try {
    const meta = await sharp(photoPath).metadata();
    const size = Math.max(meta.width, meta.height);
    const img  = await sharp(photoPath)
      .resize(size, size, { fit: "contain", position: "centre", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .jpeg({ quality: 100 })
      .toBuffer();

    await sock.query({
      tag:   "iq",
      attrs: { target: undefined, to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: img }],
    });

    await ctx.replyWithMarkdown(
      `*╭─────────⟢*\n` +
      `*│ ✅ 𝐏𝐏 𝐔𝐏𝐃𝐀𝐓𝐄𝐃*\n` +
      `*╰─────────⟢*\n\n` +
      `🖼️ Profile picture updated successfully!\n📱 \`+${phone}\``
    );
  } catch (e) {
    console.error("[setpp]", e.message);
    await ctx.reply(`❌ PP update fail: ${e.message}`);
  }

  await sleep(2000);
  await finishSession({ uid, cmdType: "setpp", sock, shared, photoPath });
}

// ═══════════════════════════════════════════════════
//  FLOW 3: CHANNEL SONG
// ═══════════════════════════════════════════════════
async function runCsongFlow({ uid, phone, state, sock, ctx, shared }) {
  const { songInput, channelInput } = state;

  await ctx.replyWithMarkdown(`✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n🎵 Song bhejna shuru...`);
  await sleep(1500);

  const channelJid = await resolveChannelJid(channelInput, sock);
  if (!channelJid) {
    await ctx.reply("❌ Invalid channel JID or link");
  } else {
    await sendSongToChannel(sock, songInput, channelJid, ctx);
  }

  await sleep(2000);
  await finishSession({ uid, cmdType: "csong", sock, shared });
}

// ═══════════════════════════════════════════════════
//  FLOW 4: GROUP STATUS
// ═══════════════════════════════════════════════════
async function runGstatusFlow({ uid, phone, state, sock, ctx, shared }) {
  const { statusType, statusContent, groupJid, caption } = state;

  await ctx.replyWithMarkdown(`✅ *Pair Successful!*\n📱 \`+${phone}\`\n\n📊 Group status bhejna shuru...`);
  await sleep(1500);

  await sendGroupStatus(sock, statusType, statusContent, groupJid, caption, ctx);

  await sleep(2000);
  await finishSession({ uid, cmdType: "gstatus", sock, shared });
}

// ═══════════════════════════════════════════════════
//  LAUNCH
// ═══════════════════════════════════════════════════
async function loadDeps() {
  const stickerPkg = await import("wa-sticker-formatter");
  Sticker          = stickerPkg.Sticker;
  StickerTypes     = stickerPkg.StickerTypes;
}

loadDeps().then(() => {
  bot.launch({ dropPendingUpdates: true });
  console.log("🤖 NeuroBot running...");
  console.log("Sessions :", SESSIONS_DIR);
  console.log("Temp     :", TEMP_DIR);
}).catch(err => {
  console.error("❌ Failed to load deps:", err);
  process.exit(1);
});

process.once("SIGINT",  () => { bot.stop(); process.exit(0); });
process.once("SIGTERM", () => { bot.stop(); process.exit(0); });
process.on("uncaughtException",  err    => console.error("[uncaughtException]",  err?.message  ?? err));
process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason?.message ?? reason));
