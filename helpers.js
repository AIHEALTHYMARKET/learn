// 純函式工具：不依賴 Firebase / DOM，方便測試與維護。

export const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Firestore Timestamp（有 seconds）或本機暫存 {seconds} → 秒數
export const secs = t => (t && typeof t.seconds === "number" ? t.seconds : 0);

export const fmtTime = s => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), rr = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
};

const YT_ID = /^[\w-]{11}$/;

// 接受：watch?v=、youtu.be、embed、shorts、live、m.youtube.com、含多餘參數的網址，或純 11 碼 ID。
// 無法辨識時回傳 null。
export function parseYoutube(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  let id = null;
  try {
    const u = new URL(v);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = u.searchParams.get("v");
      if (!id) {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        id = m ? m[1] : null;
      }
    }
  } catch (_) { /* 不是網址，往下當作純 ID */ }
  if (!id && YT_ID.test(v)) id = v;
  return id && YT_ID.test(id) ? id : null;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|wav)(\?.*)?$/i;
const DRIVE_ID = /^[\w-]{15,}$/;

// 管理員貼上的 MP3 來源 → 要存進 Firestore 的 mediaId
//  1) Google Drive 分享連結 / 檔案 ID  → 存檔案 ID
//  2) https:// 開頭的直接 MP3 網址     → 存完整網址
//  3) 同一個 GitHub 倉庫內的相對路徑（例如 audio/lesson1.mp3） → 存相對路徑
// 無法辨識時回傳 null。
export function parseMp3Source(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    let u;
    try { u = new URL(v); } catch (_) { return null; }
    if (/(^|\.)google\.com$/i.test(u.hostname)) {
      const m = u.pathname.match(/\/d\/([\w-]+)/);
      const id = m ? m[1] : u.searchParams.get("id");
      return id && DRIVE_ID.test(id) ? id : null;
    }
    return u.protocol === "https:" ? v : null; // http 會被 https 網頁擋掉（mixed content）
  }
  if (DRIVE_ID.test(v)) return v;
  if (AUDIO_EXT.test(v) && !v.includes("..") && !v.startsWith("/")) return v;
  return null;
}

// Firestore 裡的 mediaId → <audio src>
export function audioSrc(mediaId) {
  const v = String(mediaId ?? "").trim();
  if (/^https:\/\//i.test(v)) return v;
  if (AUDIO_EXT.test(v) && !DRIVE_ID.test(v)) return v.includes("%") ? v : encodeURI(v);
  return "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(v);
}
