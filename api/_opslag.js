/* api/_opslag.js — duurzame opslag van de originele audio (2026-09-05).
   ------------------------------------------------------------
   Vercel Blob als BLOB_READ_WRITE_TOKEN gezet is (bedoeld om te bewaren);
   anders een aparte Redis-sleutel naast het record, zodat het record zelf
   licht blijft en lijsten geen audio meer meeslepen. Oude records met
   `audio` inline (van vóór deze datum) blijven leesbaar.

   audioRef-vormen:  "blob:<url>"  |  "redis:<key>"  |  "inline"
   ------------------------------------------------------------ */
const { cmd } = require("./_redis");
const memo = require("./_memo");

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";

function blobActief() { return !!BLOB_TOKEN; }

/* Bewaar audio; geeft { audioRef, audioBytes }. */
async function bewaarAudio(id, base64, audioType) {
  const buf = Buffer.from(base64, "base64");
  if (blobActief()) {
    const { put } = require("@vercel/blob");
    const ext = /ogg/.test(audioType || "") ? "ogg" : /mp4|m4a|aac/.test(audioType || "") ? "m4a" : "webm";
    const r = await put("spraakbericht/" + id + "." + ext, buf, {
      access: "public", contentType: audioType || "audio/webm", token: BLOB_TOKEN, addRandomSuffix: true,
    });
    return { audioRef: "blob:" + r.url, audioBytes: buf.length };
  }
  const k = memo.key(id, "audio");
  await cmd(["SET", k, base64]);
  return { audioRef: "redis:" + k, audioBytes: buf.length };
}

/* Lees audio als Buffer, of null. rec = huidige stand van de memo. */
async function leesAudio(rec) {
  const ref = rec.audioRef || (rec.audio ? "inline" : "");
  if (!ref) return null;
  if (ref === "inline") return Buffer.from(rec.audio, "base64");
  if (ref.startsWith("redis:")) {
    const b64 = await cmd(["GET", ref.slice(6)]);
    return b64 ? Buffer.from(b64, "base64") : null;
  }
  if (ref.startsWith("blob:")) {
    const r = await fetch(ref.slice(5));
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }
  return null;
}

module.exports = { bewaarAudio, leesAudio, blobActief };
