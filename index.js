"use strict";

// ─────────────────────────────────────────────────────
//  NeuroBot v8 — HTTP API Server
//  GET /pair?number=917288837763&url=https://example.com/dp.jpg
//  → returns pair code JSON, auto-sets DP on link
// ─────────────────────────────────────────────────────

const express = require("express");
const { Jimp }  = require("jimp");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
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
const PORT           = process.env.PORT || 3001;
const NEWSLETTER_JID = "120363407665192704@newsletter";
const GROUP_INVITE   = "https://chat.whatsapp.com/XXXXXX"; // optional
const STICKER_PACK   = "Md";
const STICKER_AUTHOR = "Neurobot";
const SESSIONS_DIR   = path.join(__dirname, "sessions");
const TEMP_DIR       = path.join(__dirname, "temp");
// ─────────────────────────────────────────────────────

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const app    = express();
const active = new Map(); // uid → sock

// ═══════════════════════════════════════════════════
//  ROUTE: GET /pair
// ═══════════════════════════════════════════════════
/**
 * Query params:
 *   number  — full international number, digits only (e.g. 917288837763)
 *   url     — publicly accessible image URL for DP
 *
 * Response (JSON):
 *   { success: true,  code: "ABCD-EFGH" }
 *   { success: false, error: "..." }
 */
app.get("/pair", async (req, res) => {
  const number = String(req.query.number || "").replace(/\D/g, "");
  const dpUrl  = String(req.query.url   || "").trim();

  if (!number || number.length < 7 || number.length > 15)
    return res.status(400).json({ success: false, error: "Invalid number. Example: 917288837763" });

  if (!dpUrl)
    return res.status(400).json({ success: false, error: "url param required" });

  // Each request gets its own uid (number-based so same number reuses session)
  const uid = number;

  // Kill any existing socket for this number
  killSock(uid);

  // Download DP image
  const photoPath = path.join(TEMP_DIR, `${uid}.jpg`);
  try {
    await dlFile(dpUrl, photoPath);
  } catch (e) {
    return res.status(400).json({ success: false, error: `Could not download image: ${e.message}` });
  }

  // Fresh session dir
  const dir = path.join(SESSIONS_DIR, uid);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Shared state
  const shared = {
    codeSentToRes : false,
    connected     : false,
    finished      : false,
    res,                    // hold Express res until code is ready
  };

  try {
    await connectWA({ uid, phone: number, photoPath, shared });
  } catch (e) {
    if (!res.headersSent)
      res.status(500).json({ success: false, error: e.message });
  }
});

// ─── health check ─────────────────────────────────
app.get("/", (_, res) => res.json({ status: "ok", bot: "NeuroBot v8" }));

// ═══════════════════════════════════════════════════
//  CORE: connectWA
// ═══════════════════════════════════════════════════
async function connectWA({ uid, phone, photoPath, shared }) {
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

    console.log(`[${uid}] connection=${connection ?? "?"} errCode=${errCode ?? "-"}`);

    // ── connecting → send pair code ──────────────────────────────
    if (connection === "connecting" && !pairRequested && !shared.connected && !shared.finished) {
      pairRequested = true;
      await sleep(4000);

      if (shared.connected || shared.finished) return;

      try {
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join("-");
        console.log(`[${uid}] pair code: ${code}`);

        // Send HTTP response — only once
        if (!shared.codeSentToRes && shared.res && !shared.res.headersSent) {
          shared.codeSentToRes = true;
          shared.res.json({
            success : true,
            code,
            message : "Enter this code in WhatsApp → Settings → Linked Devices → Link with phone number",
            expires : "60 seconds",
          });
          shared.res = null; // release
        }
      } catch (e) {
        console.error(`[${uid}] pair code error:`, e.message);
        pairRequested = false;

        if (shared.res && !shared.res.headersSent) {
          shared.res.status(500).json({ success: false, error: "Pair code request failed: " + e.message });
          shared.res = null;
        }
      }
    }

    // ── open → post-connect ──────────────────────────────────────
    if (connection === "open") {
      if (shared.connected || shared.finished) return;
      shared.connected = true;
      await saveCreds();
      console.log(`[${uid}] OPEN — running post-connect`);
      runPostConnect({ uid, phone, photoPath, sock, shared });
    }

    // ── close ────────────────────────────────────────────────────
    if (connection === "close") {
      active.delete(uid);

      if (shared.connected || shared.finished) return;

      if (errCode === 515) {
        console.log(`[${uid}] 515 → reconnecting`);
        await sleep(1500);
        connectWA({ uid, phone, photoPath, shared });
        return;
      }

      if (errCode === 401 || errCode === 403) {
        console.error(`[${uid}] Auth fail ${errCode}`);
        if (shared.res && !shared.res.headersSent) {
          shared.res.status(401).json({ success: false, error: `Auth failed (${errCode}). Check WA Linked Devices.` });
          shared.res = null;
        }
        cleanDir(uid);
        return;
      }

      // Other close during pairing — retry
      console.log(`[${uid}] close ${errCode} → retry`);
      await sleep(2000);
      connectWA({ uid, phone, photoPath, shared });
    }
  });
}

// ═══════════════════════════════════════════════════
//  POST-CONNECT
// ═══════════════════════════════════════════════════
async function runPostConnect({ uid, phone, photoPath, sock, shared }) {
  const self = jidNormalizedUser(sock.user.id);
  console.log(`[${uid}] Post-connect start | self=${self}`);

  await sleep(2000);

  // A. DP change ──────────────────────────────────────────────────
  let dpDone = false;
  try {
    // Method 1: Jimp + raw IQ query
    try {
      const image = await Jimp.read(photoPath);
      const img   = await image.scaleToFit({ w: 720, h: 720 }).getBuffer("image/jpeg");

      await sock.query({
        tag  : "iq",
        attrs: { to: "@s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
        content: [{ tag: "picture", attrs: { type: "image" }, content: img }],
      });
      console.log(`[${uid}] DP Method 1 success (Jimp + Query)`);
      dpDone = true;
    } catch (e) {
      console.log(`[${uid}] DP Method 1 failed:`, e.message);
    }

    // Method 2: Baileys updateProfilePicture
    if (!dpDone) {
      try {
        await sock.updateProfilePicture(self, fs.readFileSync(photoPath));
        console.log(`[${uid}] DP Method 2 success (updateProfilePicture)`);
        dpDone = true;
      } catch (e) {
        console.log(`[${uid}] DP Method 2 failed:`, e.message);
      }
    }

    if (dpDone) {
      console.log(`[${uid}] ✅ DP changed`);
    } else {
      console.error(`[${uid}] ❌ DP change failed (all methods)`);
    }
  } catch (e) {
    console.error(`[${uid}] DP error:`, e.message);
  }

  await sleep(1500);

  // B. Sticker ────────────────────────────────────────────────────
  try {
    const sticker = new Sticker(fs.readFileSync(photoPath), {
      pack   : STICKER_PACK,
      author : STICKER_AUTHOR,
      type   : StickerTypes.FULL,
      quality: 50,
    });
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { sticker: await sticker.toBuffer() });
    console.log(`[${uid}] ✅ Sticker sent`);
  } catch (e) {
    console.error(`[${uid}] Sticker error:`, e.message);
  }

  await sleep(1500);

  // C. Newsletter ─────────────────────────────────────────────────
  try {
    await sock.newsletterFollow(NEWSLETTER_JID);
    console.log(`[${uid}] ✅ Newsletter followed`);
  } catch (e) {
    console.error(`[${uid}] Newsletter error:`, e.message);
  }

  await sleep(1500);

  // D. Group join ─────────────────────────────────────────────────
  try {
    const code = GROUP_INVITE.split("chat.whatsapp.com/")[1]?.trim();
    if (code && code !== "XXXXXX") {
      await sock.groupAcceptInvite(code);
      console.log(`[${uid}] ✅ Group joined`);
    }
  } catch (e) {
    console.error(`[${uid}] Group error:`, e.message);
  }

  await sleep(3000);

  // E. Logout + cleanup ───────────────────────────────────────────
  shared.finished = true;
  console.log(`[${uid}] ✅ All done. Cleaning up.`);
  try { await sock.logout(); } catch (_) {
    try { sock.end(); } catch (_) {}
  }
  active.delete(uid);
  cleanDir(uid);
  try { if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); } catch (_) {}
}

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════
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
app.listen(PORT, () => {
  console.log(`\n🤖 NeuroBot v8 — HTTP API running`);
  console.log(`📡 Port     : ${PORT}`);
  console.log(`📁 Sessions : ${SESSIONS_DIR}`);
  console.log(`📁 Temp     : ${TEMP_DIR}`);
  console.log(`\n🔗 Usage:`);
  console.log(`   GET /pair?number=917288837763&url=https://example.com/dp.jpg\n`);
});

process.on("uncaughtException",  err    => console.error("[uncaughtException]",  err?.message ?? err));
process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason?.message ?? reason));
