import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, getDocs, query, where, orderBy, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { esc, secs, fmtTime, parseYoutube, parseMp3Source, audioSrc, driveIdOf, driveSources, parseFlip, safeCover } from "./helpers.js";

/* ───────────── 設定 ───────────── */
// 管理員 Gmail。必須與 firestore.rules 裡的 isAdmin() Email 完全相同。
const ADMIN_EMAIL = "diabolo.weien@gmail.com";
// 播放時最少每隔幾毫秒才寫入一次進度（避免超出 Firebase Spark 免費寫入額度）。
const SAVE_EVERY_MS = 20000;

const $ = id => document.getElementById(id);
const configMissing = !firebaseConfig || Object.values(firebaseConfig).some(v => !v || /YOUR_/.test(String(v)));
let auth = null, db = null;
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
if (!configMissing) { const app = initializeApp(firebaseConfig); auth = getAuth(app); db = getFirestore(app); }

/* ───────────── 狀態 ───────────── */
let currentUser = null, isAdmin = false, profile = null;
let categories = [], lessons = [], progressMap = {}, notes = [], announcements = [], books = [], accessMap = {};
let currentCategory = null, currentView = "home";
let activeLesson = null, audioEl = null, ytPlayer = null, ytTimer = null, lastSaveAt = 0, lastSavedPos = -1;

/* ───────────── 小工具 ───────────── */
let toastTimer;
const toast = msg => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200); };
const isAdminUser = u => !!u?.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
const isApproved = () => isAdmin || profile?.status === "approved"; // 舊制整體會員資格：目前只用在「需審核的書本」
// 分類進入權限：營養課程與「需審核」的分類，要先提出申請，管理員核准後才能進入
const needsApproval = c => c.type === "nutrition" || !!c.requiresApproval;
const accessStatus = c => accessMap[c.id] || "";   // "" | "pending" | "approved"
const categoryAllowed = c => isAdmin || !needsApproval(c) || accessMap[c.id] === "approved";
const progressFor = id => progressMap[id] || { percent: 0, completed: false, position: 0 };
const catName = id => categories.find(c => c.id === id)?.name || "未分類";
// 排序：有 order 的依 order 由小到大；沒有 order 的（舊資料或新增的）排在後面，依新增時間
const sortKey = x => typeof x.order === "number" ? x.order : 1e12 + secs(x.createdAt);
const byOrder = (x, y) => sortKey(x) - sortKey(y);
const byCreated = (x, y) => secs(x.createdAt) - secs(y.createdAt);
const nowStamp = () => ({ seconds: Math.floor(Date.now() / 1000) });
const run = async (fn, okMsg) => {
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) { console.error(e); toast("操作失敗：" + (e.code === "permission-denied" ? "沒有權限（請確認 Firestore Rules 已發布、且用管理員帳號登入）" : (e.message || e.code))); return false; }
};

/* ───────────── 登入 ───────────── */
const ua = navigator.userAgent || "";
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|WhatsApp|Messenger|Snapchat|TikTok|; wv\)/i.test(ua);
function authErrorText(e) {
  switch (e?.code) {
    case "auth/unauthorized-domain": return "此網站網域尚未加入 Firebase 的「已授權網域」。請到 Firebase → Authentication → Settings → Authorized domains 加入你的 GitHub Pages 網域。";
    case "auth/popup-blocked": return "瀏覽器擋住了登入視窗，請允許彈出視窗後再試一次。";
    case "auth/network-request-failed": return "網路連線失敗，請檢查網路後再試。";
    case "auth/operation-not-allowed": return "尚未在 Firebase 啟用 Google 登入方式。";
    case "auth/internal-error": case "auth/invalid-api-key": return "Firebase 設定可能有誤，請重新檢查 firebase-config.js。";
    default: return (e?.message || "登入失敗") + (e?.code ? `（${e.code}）` : "");
  }
}
if (configMissing) {
  $("loginError").textContent = "尚未完成設定：請先把 Firebase 網頁應用程式設定貼進 firebase-config.js（見 SETUP_GUIDE）。";
  $("loginBtn").disabled = true;
} else if (inAppBrowser) {
  $("loginError").textContent = "偵測到你可能正在 LINE／Facebook／WhatsApp 等 App 內建瀏覽器開啟，Google 會擋住這裡的登入。請點右上角選單，選「用 Chrome／Safari 開啟」。";
}
$("loginBtn").addEventListener("click", async () => {
  if (configMissing) return;
  $("loginError").textContent = "";
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
    }
    $("loginError").textContent = authErrorText(e);
  }
});
const doLogout = () => signOut(auth);
$("logoutBtn").addEventListener("click", doLogout);
$("logoutTop").addEventListener("click", doLogout);
if (auth) getRedirectResult(auth).catch(e => { $("loginError").textContent = authErrorText(e); });

/* ───────────── 載入資料 ───────────── */
async function loadAll() {
  isAdmin = isAdminUser(currentUser);
  const uid = currentUser.uid;
  const [p, c, pr, n, a, ac] = await Promise.all([
    getDoc(doc(db, "users", uid)),
    getDocs(query(collection(db, "categories"), orderBy("createdAt", "asc"))),
    getDocs(collection(db, "users", uid, "progress")),
    getDocs(collection(db, "users", uid, "notes")),
    getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"))),
    // 我的分類申請紀錄（Rules 只允許用 uid 條件查自己的）
    getDocs(query(collection(db, "categoryAccess"), where("uid", "==", uid))).catch(e => { console.warn("讀取分類申請失敗（Firestore Rules 可能尚未更新）", e.code); return null; })
  ]);
  accessMap = {}; ac?.forEach(d => { const x = d.data(); if (x.categoryId) accessMap[x.categoryId] = x.status; });
  if (p.exists()) profile = p.data();
  else {
    const base = { email: currentUser.email, name: currentUser.displayName || "", photoURL: currentUser.photoURL || "", status: "pending", createdAt: serverTimestamp() };
    await setDoc(doc(db, "users", uid), base);
    profile = { ...base, createdAt: nowStamp() };
  }
  categories = c.docs.map(d => ({ id: d.id, ...d.data() })).sort(byOrder);
  // 管理員一次讀全部；其他人只查詢「有權進入的分類」，這樣才符合 Firestore Rules。
  let snaps;
  if (isAdmin) snaps = [await getDocs(query(collection(db, "lessons"), orderBy("createdAt", "asc")))];
  else snaps = await Promise.all(
    categories.filter(cat => categoryAllowed(cat))
      .map(cat => getDocs(query(collection(db, "lessons"), where("categoryId", "==", cat.id))).catch(e => { console.warn("讀取分類課程失敗", cat.id, e.code); return null; }))
  );
  lessons = snaps.filter(Boolean).flatMap(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  lessons.sort(byOrder); // 依管理員設定的順序排列（未設定的依新增時間）
  // 書本：未核准會員只能查「不需審核」的書（才符合 Rules）。失敗（例如 Rules 尚未更新）不影響其他功能。
  try {
    const bs = isApproved()
      ? await getDocs(query(collection(db, "books"), orderBy("createdAt", "asc")))
      : await getDocs(query(collection(db, "books"), where("requiresApproval", "==", false)));
    books = bs.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => secs(x.createdAt) - secs(y.createdAt));
  } catch (e) { console.warn("讀取書本失敗（Firestore Rules 可能尚未更新）", e.code); books = []; }
  progressMap = {}; pr.forEach(d => progressMap[d.id] = d.data());
  notes = n.docs.map(d => ({ id: d.id, ...d.data() }));
  announcements = a.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderShell(reset) {
  $("loginScreen").classList.add("hidden"); $("appShell").classList.remove("hidden");
  $("userName").textContent = currentUser.displayName || "學習者"; $("userEmail").textContent = currentUser.email;
  $("userAvatar").textContent = (currentUser.displayName || "U").slice(0, 1).toUpperCase();
  $("welcomeName").textContent = " · " + (currentUser.displayName || "學習者");
  $("adminNavWrap").classList.toggle("hidden", !isAdmin);
  const pendingN = categories.filter(c => accessMap[c.id] === "pending").length;
  $("approvalBanner").classList.toggle("hidden", !pendingN);
  if (pendingN) $("approvalBanner").textContent = `你有 ${pendingN} 個分類的進入申請正在等待管理員審核。核准後請按右上角 ↻ 重新整理，即可進入該分類。`;
  if (reset) { currentView = "home"; currentCategory = null; }
  setView(currentView, !reset);
}

// 讀取資料並重畫目前畫面（管理員新增／刪除後不會被踢回首頁）
async function reload(reset = false) { await loadAll(); renderShell(reset); }

const VIEW_TITLES = { home: "學習總覽", mp3: "MP3 聆聽學習", nutrition: "營養課程", reading: "閱讀", notes: "我的筆記", admin: "管理員後台" };
function setView(name, keep = false) {
  if (name === "admin" && !isAdmin) name = "home";
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("view-" + name)?.classList.remove("hidden");
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "home") renderHome();
  else if (name === "mp3" || name === "nutrition") {
    const box = $(name === "mp3" ? "mp3Lessons" : "nutritionLessons");
    const stillOpen = keep && currentCategory && !box.classList.contains("hidden") && categories.some(c => c.id === currentCategory.id);
    if (stillOpen) openCategory(currentCategory.id); else renderCategories(name);
  }
  else if (name === "reading") renderBooks();
  else if (name === "notes") renderNotes();
  else if (name === "admin") loadAdmin();
  if (!keep) window.scrollTo({ top: 0 });
}

$("refreshBtn").addEventListener("click", async () => { try { await reload(false); toast("資料已更新"); } catch (e) { console.error(e); toast("更新失敗：" + (e.code || e.message)); } });
document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => setView(b.dataset.goto)));

function loadErrorText(e) {
  if (e?.code === "permission-denied") return "已登入，但沒有權限讀取資料：通常是 Firestore Rules 尚未發布，或規則內的管理員 Email 與你登入的帳號不同。";
  if (e?.code === "unavailable" || e?.code === "failed-precondition") return "已登入，但連不上 Firestore：請確認已在 Firebase 建立 Firestore Database，且網路正常。";
  return "已登入，但讀取資料失敗：" + (e?.code || e?.message || "未知錯誤");
}
function resetState() {
  closeModal(true); closeReader();
  currentUser = null; isAdmin = false; profile = null; categories = []; lessons = []; progressMap = {}; notes = []; announcements = []; books = []; accessMap = {}; currentCategory = null; currentView = "home";
  $("appShell").classList.add("hidden"); $("loginScreen").classList.remove("hidden");
}
if (auth) onAuthStateChanged(auth, async user => {
  if (!user) { resetState(); return; }
  currentUser = user;
  try { await reload(true); $("loginError").textContent = ""; }
  catch (e) {
    console.error(e);
    $("appShell").classList.add("hidden"); $("loginScreen").classList.remove("hidden");
    $("loginError").textContent = loadErrorText(e);
    toast("讀取資料失敗");
  }
});

/* ───────────── 首頁／分類／課程列表 ───────────── */
function lessonStats() {
  const vis = lessons.filter(l => categoryAllowed(categories.find(c => c.id === l.categoryId) || {}));
  const vals = vis.map(l => progressFor(l.id)), total = vis.length;
  const completed = vals.filter(v => v.completed).length, started = vals.filter(v => v.percent > 0 && !v.completed).length;
  const percent = total ? Math.round(vals.reduce((s, v) => s + (v.completed ? 100 : (v.percent || 0)), 0) / total) : 0;
  return { total, completed, started, percent };
}
function renderHome() {
  const s = lessonStats();
  $("overallPercent").textContent = s.percent + "%"; $("overallBar").style.width = s.percent + "%";
  $("overallText").textContent = s.total ? `已完成 ${s.completed} / ${s.total} 個學習內容` : "尚未開始學習";
  $("completedCount").textContent = s.completed; $("inProgressCount").textContent = s.started; $("notesCount").textContent = notes.length;
  const cont = lessons.filter(l => progressFor(l.id).percent > 0 && !progressFor(l.id).completed)
    .sort((a, b) => secs(progressFor(b.id).updatedAt) - secs(progressFor(a.id).updatedAt)).slice(0, 4);
  $("continueList").innerHTML = cont.length ? cont.map(l => `<div class="lesson-row"><div class="lesson-thumb">${l.type === "mp3" ? "♫" : "✧"}</div><div class="lesson-row-main"><b>${esc(l.title)}</b><small>${esc(catName(l.categoryId))}</small></div><div class="mini-progress"><small>${progressFor(l.id).percent || 0}%</small><div class="progress-track"><i style="width:${progressFor(l.id).percent || 0}%"></i></div></div><button class="mini-btn" data-open="${esc(l.id)}">繼續</button></div>`).join("") : "<div class='empty-state'>目前還沒有學習紀錄。</div>";
  $("newList").innerHTML = announcements.slice(0, 3).map(a => `<div class="new-row"><div class="lesson-thumb">✦</div><div class="lesson-row-main"><b>${esc(a.title)}</b><small>${esc(a.body)}</small></div></div>`).join("")
    || [...lessons].sort(byCreated).slice(-3).reverse().map(l => `<div class="new-row"><div class="lesson-thumb">${l.type === "mp3" ? "♫" : "✧"}</div><div class="lesson-row-main"><b>${esc(l.title)}</b><small>${esc(catName(l.categoryId))}</small></div><span class="new-badge">NEW</span></div>`).join("")
    || "<div class='empty-state'>目前沒有新課程。</div>";
  $("homeCategories").innerHTML = ["mp3", "nutrition"].map(type => categoryCardHtml(categories.filter(c => c.type === type), true)).join("") || "<div class='empty-state'>目前沒有可瀏覽的分類。</div>";
  bindCategoryCards();
  $("continueList").querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLesson(b.dataset.open));
}
function categoryCardHtml(list, quiet) {
  return list.map(c => {
    const ok = categoryAllowed(c), st = accessStatus(c);
    const count = ok ? `${lessons.filter(l => l.categoryId === c.id).length} 個單元` : "🔒 需申請進入";
    const tag = ok ? (needsApproval(c) ? "審核專區 ✓" : "開放學習") : (st === "pending" ? "審核中…" : "申請進入");
    return `<article class="category-card${ok ? "" : " locked"}" data-category="${esc(c.id)}"><div class="category-icon">${c.type === "mp3" ? "♫" : "✧"}</div><h3>${esc(c.name)}</h3><p>${esc(c.description || "依照主題循序學習，累積知識與實戰能力。")}</p><div class="category-meta"><span>${count}</span><span>${tag}　→</span></div></article>`;
  }).join("")
    || (quiet ? "" : "<div class='empty-state'>目前沒有可瀏覽的分類。</div>");
}
function bindCategoryCards() { document.querySelectorAll("[data-category]").forEach(el => el.onclick = () => openCategory(el.dataset.category)); }
function renderCategories(type) {
  currentCategory = null;
  const list = categories.filter(c => c.type === type);
  const target = $(type === "mp3" ? "mp3Categories" : "nutritionCategories");
  target.classList.remove("hidden"); $(type === "mp3" ? "mp3Lessons" : "nutritionLessons").classList.add("hidden");
  target.innerHTML = categoryCardHtml(list); bindCategoryCards();
}
// 第一次進入需審核的分類：送出申請，等管理員核准
async function requestAccess(c) {
  if (accessMap[c.id] === "pending") { toast(`你已送出「${c.name}」的申請，請等候管理員審核`); return; }
  if (!confirm(`「${c.name}」需要管理員核准才能進入。\n要送出進入申請嗎？`)) return;
  const ok = await run(async () => {
    await setDoc(doc(db, "categoryAccess", c.id + "_" + currentUser.uid), {
      categoryId: c.id, uid: currentUser.uid, email: currentUser.email, name: currentUser.displayName || "",
      status: "pending", requestedAt: serverTimestamp()
    });
    accessMap[c.id] = "pending";
  }, "申請已送出，管理員核准後即可進入");
  if (ok) renderShell(false);
}
function openCategory(id) {
  const c = categories.find(x => x.id === id); if (!c) return;
  if (!categoryAllowed(c)) { requestAccess(c); return; }
  currentCategory = c;
  const type = c.type, cats = $(type === "mp3" ? "mp3Categories" : "nutritionCategories"), box = $(type === "mp3" ? "mp3Lessons" : "nutritionLessons");
  cats.classList.add("hidden"); box.classList.remove("hidden");
  const list = lessons.filter(l => l.categoryId === id);
  const avg = list.length ? Math.round(list.reduce((s, l) => s + (progressFor(l.id).completed ? 100 : progressFor(l.id).percent || 0), 0) / list.length) : 0;
  box.innerHTML = `<div class="category-detail-head"><button class="back-btn" data-back>← 返回分類</button><div><p class="eyebrow">CATEGORY PROGRESS</p><h2>${esc(c.name)}　<span style="font-size:13px;color:#b18b4b">${avg}%</span></h2></div></div><div class="progress-track"><i style="width:${avg}%"></i></div><div class="lesson-cards">${list.map(l => { const p = progressFor(l.id); return `<article class="lesson-card"><div class="lesson-card-footer"><span class="status-pill ${p.completed ? "done" : p.percent ? "started" : ""}">${p.completed ? "✓ 已完成" : p.percent ? "學習中 " + p.percent + "%" : "尚未開始"}</span><span class="muted" style="font-size:10px">${l.type === "mp3" ? "♫ MP3" : "▶ VIDEO"}</span></div><h3>${esc(l.title)}</h3><p>${esc(l.description || "開始學習並記錄你的重點。")}</p><div class="lesson-card-footer"><small class="muted">${p.completed ? "已完成" : p.percent ? `已學習 ${p.percent}%` : "準備開始"}</small><button class="btn btn-primary btn-small" data-open="${esc(l.id)}">${p.percent && !p.completed ? "繼續學習" : "開始學習"}</button></div></article>`; }).join("") || "<div class='empty-state'>此分類尚未新增課程。</div>"}</div>`;
  box.querySelector("[data-back]").onclick = () => renderCategories(type);
  box.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLesson(b.dataset.open));
}

/* ───────────── 學習內容視窗（MP3／YouTube） ───────────── */
function openLesson(id) {
  const l = lessons.find(x => x.id === id), c = categories.find(x => x.id === l?.categoryId);
  if (!l || !c || !categoryAllowed(c)) { toast("你沒有權限進入此內容"); return; }
  if (activeLesson) closeModal(true);
  activeLesson = l; lastSaveAt = Date.now(); lastSavedPos = -1;
  const p = progressFor(id), isMp3 = l.type === "mp3";
  $("modalContent").innerHTML = `<p class="eyebrow">${isMp3 ? "AUDIO LEARNING" : "NUTRITION COURSE"} · ${esc(c.name)}</p><h2>${esc(l.title)}</h2><p class="muted" style="font-size:12px">${esc(l.description || "")}</p><div class="media-frame ${isMp3 ? "audio" : "yt"}" id="mediaFrame">${isMp3 ? `<audio id="audioPlayer" controls preload="metadata" playsinline src="${esc(audioSrc(l.mediaId))}"></audio>` : ytBoxHtml()}</div><p id="mediaError" class="error-text hidden"></p><div class="panel-heading"><div><b style="font-size:12px">本單元進度</b><div class="progress-track lesson-progress-track"><i id="lessonProgressBar" style="width:${p.completed ? 100 : (p.percent || 0)}%"></i></div></div><span id="lessonProgressText" class="status-pill ${p.completed ? "done" : ""}">${p.completed ? "✓ 已完成" : (p.percent || 0) + "%"}</span></div><div class="note-editor"><label>我的學習筆記<textarea id="lessonNote" rows="5" maxlength="20000" placeholder="記錄重點、案例、未來分享時可以使用的說法..."></textarea></label><div class="note-actions"><small class="muted">筆記只會儲存在你的帳號內。</small><button id="saveNote" class="btn btn-primary btn-small">儲存筆記</button></div></div>`;
  $("lessonModal").classList.remove("hidden"); document.body.classList.add("modal-open");
  $("lessonNote").value = notes.find(n => n.lessonId === id)?.content || "";
  $("saveNote").onclick = () => saveNote(id);
  if (isMp3) setupAudio(p); else setupYoutube(l, p);
}
// 自製 YouTube 播放介面：隱藏 YouTube 標題列／標誌，並用透明遮罩擋住點擊與右鍵
const ytBoxHtml = () => `<div class="yt-box" id="ytBox"><div class="yt-stage"><div id="youtubePlayer"></div><div class="yt-shield idle" id="ytShield"><span class="yt-bigplay">▶</span></div></div><div class="yt-controls"><button type="button" id="ytPlay" class="yt-btn" aria-label="播放／暫停">▶</button><span id="ytTime" class="yt-time">0:00 / 0:00</span><input id="ytSeek" class="yt-seek" type="range" min="0" max="1000" value="0" aria-label="播放位置"><select id="ytRate" class="yt-rate" aria-label="播放速度"><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select><button type="button" id="ytFull" class="yt-btn" aria-label="全螢幕">⛶</button></div></div>`;
function showMediaError(msg) { const e = $("mediaError"); if (e) { e.textContent = msg; e.classList.remove("hidden"); } toast(msg); }

// 目前播放位置與總長度（MP3 或 YouTube）
function currentMedia() {
  if (!activeLesson) return null;
  if (activeLesson.type === "mp3") return audioEl ? { pos: audioEl.currentTime, dur: audioEl.duration } : null;
  if (ytPlayer && typeof ytPlayer.getCurrentTime === "function" && typeof ytPlayer.getDuration === "function") return { pos: ytPlayer.getCurrentTime(), dur: ytPlayer.getDuration() };
  return null;
}
function livePercent(lesson, m) {
  const prior = progressFor(lesson.id); if (prior.completed) return 100;
  const raw = Math.min(99, Math.floor(m.pos / m.dur * 100));
  return Math.max(prior.percent || 0, m.pos >= 5 ? Math.max(1, raw) : raw); // 往回拖不會讓進度倒退
}
// 儲存目前進度。force=true 會略過節流（暫停、關閉視窗、切到背景時使用）。
async function snapshotProgress(force = false) {
  const lesson = activeLesson, m = currentMedia();
  if (!lesson || !m || !isFinite(m.dur) || m.dur <= 0 || !isFinite(m.pos)) return;
  const pct = livePercent(lesson, m);
  updateProgressUI(pct);
  const now = Date.now();
  if (!force && now - lastSaveAt < SAVE_EVERY_MS) return;
  if (!force && Math.abs(m.pos - lastSavedPos) < 1) return;
  lastSaveAt = now; lastSavedPos = m.pos;
  const prior = progressFor(lesson.id);
  await saveProgress(lesson.id, { position: Math.floor(m.pos), percent: pct, completed: !!prior.completed });
}
async function saveProgress(id, patch) {
  const prior = progressFor(id);
  const data = { ...prior, ...patch };
  delete data.updatedAt;
  progressMap[id] = { ...data, updatedAt: nowStamp() }; // 先更新本機畫面，再寫入雲端
  if (patch.completed && !prior.completed) { paintLessonProgress(); toast("恭喜完成本單元！"); }
  try { await setDoc(doc(db, "users", currentUser.uid, "progress", id), { ...data, updatedAt: serverTimestamp() }, { merge: true }); }
  catch (e) { console.error("進度儲存失敗", e); }
}
function completeLesson(id) { if (id) saveProgress(id, { position: 0, percent: 100, completed: true }); }
function updateProgressUI(percent) {
  if (!activeLesson) return; const b = $("lessonProgressBar"), t = $("lessonProgressText"); if (!b || !t) return;
  if (progressFor(activeLesson.id).completed) { paintLessonProgress(); return; }
  b.style.width = percent + "%"; t.textContent = percent + "%";
}
function paintLessonProgress() {
  if (!activeLesson) return; const b = $("lessonProgressBar"), t = $("lessonProgressText"); if (!b || !t) return;
  const p = progressFor(activeLesson.id), pct = p.completed ? 100 : (p.percent || 0);
  b.style.width = pct + "%"; t.textContent = p.completed ? "✓ 已完成" : pct + "%"; t.classList.toggle("done", !!p.completed);
}

function setupAudio(p) {
  const audio = $("audioPlayer"); audioEl = audio;
  const resumePos = !p.completed && p.position > 3 ? p.position : 0;
  let tries = 0, done = !resumePos;
  // 手機（尤其 iOS Safari）常在 loadedmetadata 時忽略 currentTime，所以在 canplay／playing 再試，最多 4 次。
  const tryResume = () => {
    if (done || !isFinite(audio.duration) || audio.duration <= 0) return;
    if (resumePos >= audio.duration - 3) { done = true; return; }
    try { audio.currentTime = resumePos; } catch (_) { /* 忽略 */ }
    const ok = Math.abs(audio.currentTime - resumePos) < 2;
    if (ok || ++tries >= 4) { done = true; if (ok) toast("已接續到 " + fmtTime(resumePos)); }
  };
  ["loadedmetadata", "canplay", "playing"].forEach(ev => audio.addEventListener(ev, tryResume));
  audio.addEventListener("timeupdate", () => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    if (!done && audio.currentTime < resumePos - 2) return; // 續播位置尚未套用前，不要把 0 秒寫回去
    snapshotProgress(false);
  });
  audio.addEventListener("pause", () => { if (!audio.ended) snapshotProgress(true); });
  audio.addEventListener("ended", () => completeLesson(activeLesson?.id));
  // Drive 檔案播放失敗時：依序換備援網址 → 仍失敗就改用 Drive 內建播放器（可聽，但無法自動記錄進度）
  let srcIdx = 0;
  audio.addEventListener("error", () => {
    const id = driveIdOf(activeLesson?.mediaId);
    if (id) {
      const list = driveSources(id);
      if (srcIdx < list.length - 1) { srcIdx++; audio.src = list[srcIdx]; audio.load(); return; }
      const er = audio.error;
      showDrivePreview(id, `診斷：錯誤碼 ${er ? er.code : "?"}、網路狀態 ${audio.networkState}、已試 ${list.length} 個網址`); return;
    }
    showMediaError("音檔無法播放：請確認網址可直接開啟播放（https 直連 mp3）。");
  });
}
function showDrivePreview(id, diag = "") {
  const lessonId = activeLesson?.id; if (!lessonId) return;
  audioEl = null;
  $("mediaFrame").classList.remove("audio");
  $("mediaFrame").innerHTML = `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(id)}/preview" allow="autoplay" style="width:100%;height:100%;border:0"></iframe>`;
  const e = $("mediaError");
  e.innerHTML = `已改用 Google Drive 內建播放器。此模式無法自動記錄進度與續播，聽完後請按：<button id="markDone" class="btn btn-primary btn-small" style="margin-left:8px">標記為已完成</button><br><small>${esc(diag)}</small>`;
  e.classList.remove("hidden");
  $("markDone").onclick = () => completeLesson(lessonId);
}

function setupYoutube(l, p) {
  const videoId = parseYoutube(l.mediaId);
  if (!videoId) { showMediaError("這個課程的 YouTube 連結無法辨識，請管理員重新新增。"); return; }
  const start = !p.completed && p.position > 3 ? Math.floor(p.position) : 0;
  const box = $("ytBox"), shield = $("ytShield"), playBtn = $("ytPlay"), seek = $("ytSeek"), timeEl = $("ytTime"), rate = $("ytRate"), full = $("ytFull");
  let state = -1, tries = 0, dragging = false, everPlayed = false;
  const stopTicker = () => { if (ytTimer) { clearInterval(ytTimer); ytTimer = null; } };
  const setShield = cls => { shield.className = "yt-shield " + cls; };
  const paintTime = () => {
    const m = currentMedia(); if (!m || !isFinite(m.dur) || m.dur <= 0) return;
    if (!dragging) seek.value = Math.round(m.pos / m.dur * 1000);
    timeEl.textContent = fmtTime(m.pos) + " / " + fmtTime(m.dur);
  };
  const tick = () => { paintTime(); snapshotProgress(false); };
  const toggle = () => {
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== "function") return;
    const s = ytPlayer.getPlayerState();
    if (s === 1) { ytPlayer.pauseVideo(); return; }
    if (s === 0) ytPlayer.seekTo(0, true);
    ytPlayer.playVideo();
    // 少數手機瀏覽器不允許由外層按鈕啟動：2.5 秒沒開始播就暫時讓使用者直接點影片本身
    if (!everPlayed) setTimeout(() => { if (activeLesson?.id === l.id && !everPlayed) { shield.classList.add("passthrough"); toast("請直接點影片中央的播放鍵開始播放"); } }, 2500);
  };
  shield.addEventListener("click", toggle);
  playBtn.addEventListener("click", toggle);
  box.addEventListener("contextmenu", e => e.preventDefault());
  seek.addEventListener("input", () => { dragging = true; const m = currentMedia(); if (m && m.dur > 0) timeEl.textContent = fmtTime(m.dur * seek.value / 1000) + " / " + fmtTime(m.dur); });
  seek.addEventListener("change", () => {
    const m = currentMedia(); dragging = false;
    if (m && m.dur > 0) { ytPlayer.seekTo(m.dur * seek.value / 1000, true); setTimeout(() => snapshotProgress(true), 700); }
  });
  rate.addEventListener("change", () => { try { ytPlayer.setPlaybackRate(parseFloat(rate.value)); } catch (_) { /* 忽略 */ } });
  if (!(box.requestFullscreen || box.webkitRequestFullscreen)) full.style.display = "none"; // iPhone Safari 不支援網頁元素全螢幕
  full.addEventListener("click", () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (box.requestFullscreen || box.webkitRequestFullscreen).call(box);
  });
  const wait = () => {
    if (!activeLesson || activeLesson.id !== l.id) return; // 視窗已關閉
    if (window.YT && window.YT.Player) {
      ytPlayer = new YT.Player("youtubePlayer", {
        videoId,
        playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, start, origin: location.origin },
        events: {
          onReady: () => paintTime(),
          onStateChange: e => {
            state = e.data;
            if (e.data === 1) { everPlayed = true; stopTicker(); ytTimer = setInterval(tick, 500); setShield("playing"); playBtn.textContent = "❚❚"; paintTime(); }
            else if (e.data === 2) { stopTicker(); paintTime(); snapshotProgress(true); setShield("paused"); playBtn.textContent = "▶"; }
            else if (e.data === 0) { stopTicker(); completeLesson(l.id); setShield("ended"); playBtn.textContent = "↻"; }
          },
          onError: e => showMediaError([101, 150, 153].includes(e.data) ? "這支影片不允許嵌入播放，請管理員改用允許嵌入的影片。" : [100].includes(e.data) ? "找不到這支影片（可能已刪除或設為私人）。" : "影片無法播放（代碼 " + e.data + "）。")
        }
      });
    } else if (++tries > 40) showMediaError("影片播放器載入失敗：請檢查網路，或關閉會阻擋播放器的廣告攔截器後重新整理。");
    else setTimeout(wait, 300);
  };
  wait();
}

function closeModal(silent) {
  if (document.fullscreenElement && document.exitFullscreen) { try { document.exitFullscreen(); } catch (_) { /* 忽略 */ } }
  if (activeLesson) snapshotProgress(true); // 同步取得目前位置後再關閉播放器，避免遺失最後幾秒
  const had = activeLesson; activeLesson = null;
  if (ytTimer) { clearInterval(ytTimer); ytTimer = null; }
  try { audioEl?.pause(); } catch (_) { /* 忽略 */ }
  try { ytPlayer?.destroy?.(); } catch (_) { /* 忽略 */ }
  audioEl = null; ytPlayer = null;
  $("modalContent").innerHTML = ""; $("lessonModal").classList.add("hidden"); document.body.classList.remove("modal-open");
  if (had && !silent) {
    if ((currentView === "mp3" || currentView === "nutrition") && currentCategory) openCategory(currentCategory.id);
    else if (currentView === "home") renderHome();
  }
}
document.querySelectorAll("[data-close]").forEach(x => x.addEventListener("click", () => closeModal()));
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if (readerOpen) closeReader(); else if (activeLesson) closeModal(); });
// 手機切到背景、鎖屏、關閉分頁時，盡量把最後進度存起來
document.addEventListener("visibilitychange", () => { if (document.hidden) snapshotProgress(true); });
window.addEventListener("pagehide", () => snapshotProgress(true));

/* ───────────── 閱讀（FlipHTML5 電子書） ───────────── */
let readerOpen = false;
function renderBooks() {
  let html = books.map(b => { const cv = safeCover(b.cover); return `<article class="book-card" data-book="${esc(b.id)}"><div class="book-cover">${cv ? `<img src="${esc(cv)}" alt="${esc(b.title)}" loading="lazy">` : `<div class="book-cover-ph">◫</div>`}${b.requiresApproval ? '<span class="book-lock">審核專區</span>' : ""}</div><h3>${esc(b.title)}</h3><p>${esc(b.description || "")}</p></article>`; }).join("");
  if (!html) html = "<div class='empty-state' style='grid-column:1/-1'>目前還沒有書本。</div>";
  if (!isApproved()) html += "<div class='empty-state' style='grid-column:1/-1'>🔒 部分書本需要管理員核准後才會顯示。核准後請按右上角 ↻ 重新整理。</div>";
  $("bookGrid").innerHTML = html;
  $("bookGrid").querySelectorAll("[data-book]").forEach(el => el.onclick = () => openBook(el.dataset.book));
}
function openBook(id) {
  const b = books.find(x => x.id === id); if (!b) return;
  if (b.requiresApproval && !isApproved()) { toast("此書需要管理員審核通過"); return; }
  const url = parseFlip(b.link); if (!url) { toast("這本書的連結無法使用，請管理員重新編輯"); return; }
  $("readerTitle").textContent = b.title;
  $("readerBody").innerHTML = `<iframe src="${esc(url)}" title="${esc(b.title)}" allowfullscreen allow="fullscreen"></iframe>`;
  $("readerModal").classList.remove("hidden"); document.body.classList.add("modal-open"); readerOpen = true;
}
function closeReader() {
  $("readerBody").innerHTML = ""; $("readerModal").classList.add("hidden"); readerOpen = false;
  if (!activeLesson) document.body.classList.remove("modal-open");
}
$("readerClose").addEventListener("click", closeReader);

/* ───────────── 筆記 ───────────── */
let savingNote = false;
async function saveNote(lessonId) {
  if (savingNote) return;
  const content = $("lessonNote").value.trim(), old = notes.find(n => n.lessonId === lessonId), btn = $("saveNote");
  if (!content && !old) { toast("請先輸入筆記內容"); return; }
  savingNote = true; btn.disabled = true;
  try {
    if (!content && old) { // 清空內容 = 刪除這則筆記
      if (!confirm("筆記內容是空的，要刪除這則筆記嗎？")) return;
      await deleteDoc(doc(db, "users", currentUser.uid, "notes", old.id));
      notes = notes.filter(n => n.id !== old.id); toast("筆記已刪除");
    } else if (old) {
      await updateDoc(doc(db, "users", currentUser.uid, "notes", old.id), { content, updatedAt: serverTimestamp() });
      old.content = content; old.updatedAt = nowStamp(); toast("筆記已儲存");
    } else {
      // 用課程 ID 當筆記 ID：連點兩次也只會有一則，不會重複
      const data = { lessonId, title: activeLesson.title, categoryName: catName(activeLesson.categoryId), content };
      await setDoc(doc(db, "users", currentUser.uid, "notes", lessonId), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      notes.push({ id: lessonId, ...data, createdAt: nowStamp(), updatedAt: nowStamp() }); toast("筆記已儲存");
    }
    $("notesCount").textContent = notes.length;
  } catch (e) { console.error(e); toast("筆記儲存失敗：" + (e.code || e.message)); }
  finally { savingNote = false; if (btn.isConnected) btn.disabled = false; }
}
function renderNotes() {
  $("allNotes").innerHTML = notes.length ? notes.slice().sort((a, b) => secs(b.updatedAt) - secs(a.updatedAt)).map(n => `<article class="note-card"><h3>${esc(n.title || "學習筆記")}</h3><small>${esc(n.categoryName || "")} · ${secs(n.updatedAt) ? new Date(secs(n.updatedAt) * 1000).toLocaleDateString() : ""}</small><p>${esc(n.content)}</p></article>`).join("")
    : "<div class='empty-state'>尚未建立筆記。進入任一學習單元即可記錄重點。</div>";
}

/* ───────────── 管理員後台 ───────────── */
function refreshCategoryOptions() {
  const type = $("lessonType").value, list = categories.filter(c => c.type === type);
  $("lessonCategory").innerHTML = list.length ? list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("") : `<option value="">（請先在左邊新增此專區的分類）</option>`;
}
function applyLessonTypeUI() {
  const nut = $("lessonType").value === "nutrition";
  $("mediaLabelText").textContent = nut ? "YouTube 影片連結" : "MP3 來源（Google Drive 連結／檔案 ID，或 https 直連網址，或倉庫內路徑）";
  $("lessonMedia").placeholder = nut ? "貼上 YouTube 網址或 11 碼影片 ID" : "例如 Drive 分享連結，或 audio/lesson1.mp3";
  $("mediaHint").textContent = nut ? "使用可嵌入播放的 YouTube 影片。私人影片無法播放。" : "Drive 檔案需設為「知道連結的任何人可檢視」。也可把 MP3 放進 GitHub 倉庫的 audio 資料夾，填 audio/檔名.mp3（較穩定）。";
  refreshCategoryOptions();
}
$("lessonType").onchange = applyLessonTypeUI;
$("categoryType").onchange = () => { $("categoryApproval").checked = $("categoryType").value === "nutrition"; };
$("categoryForm").onsubmit = async e => {
  e.preventDefault();
  const name = $("categoryName").value.trim(); if (!name) { toast("請輸入分類名稱"); return; }
  const form = e.target;
  await run(async () => {
    await addDoc(collection(db, "categories"), { type: $("categoryType").value, name, description: $("categoryDesc").value.trim(), requiresApproval: $("categoryType").value === "nutrition" || $("categoryApproval").checked, createdAt: serverTimestamp() });
    form.reset(); await reload(false);
  }, "分類已新增");
};
$("lessonForm").onsubmit = async e => {
  e.preventDefault();
  const type = $("lessonType").value, categoryId = $("lessonCategory").value, title = $("lessonTitle").value.trim(), raw = $("lessonMedia").value;
  if (!categoryId) { toast("請先新增分類"); return; }
  if (!title) { toast("請輸入內容標題"); return; }
  const mediaId = type === "mp3" ? parseMp3Source(raw) : parseYoutube(raw);
  if (!mediaId) { toast(type === "mp3" ? "無法辨識 MP3 來源：請貼 Drive 檔案連結／ID，或 https 開頭的 MP3 網址，或 audio/檔名.mp3" : "無法辨識 YouTube 連結：請貼完整影片網址或 11 碼影片 ID"); return; }
  const form = e.target;
  await run(async () => {
    await addDoc(collection(db, "lessons"), { type, categoryId, title, description: $("lessonDesc").value.trim(), mediaId, createdAt: serverTimestamp() });
    form.reset(); applyLessonTypeUI(); await reload(false);
  }, "學習內容已新增");
};
const moveBtns = (kind, id, i, n) => `<button class="mini-btn" data-move="${kind}:${esc(id)}:-1" ${i === 0 ? "disabled" : ""} title="上移" aria-label="上移">↑</button><button class="mini-btn" data-move="${kind}:${esc(id)}:1" ${i === n - 1 ? "disabled" : ""} title="下移" aria-label="下移">↓</button>`;
const adminLessonRow = (l, i, n) => `<div class="admin-item" style="padding-left:25px"><div><b>${esc(l.title)}</b><small>${l.type === "mp3" ? "MP3" : "YouTube"}</small></div><div class="admin-actions">${i == null ? "" : moveBtns("lesson", l.id, i, n)}<button class="mini-btn" data-editlesson="${esc(l.id)}">編輯</button><button class="mini-btn danger" data-dellesson="${esc(l.id)}">刪除內容</button></div></div>`;
// 把同一專區的分類（或同一分類內的課程）依目前順序重新編號，交換位置後一次寫入
async function moveItem(kind, id, dir) {
  const item = (kind === "category" ? categories : lessons).find(x => x.id === id); if (!item) return;
  const group = (kind === "category" ? categories.filter(c => c.type === item.type) : lessons.filter(l => l.categoryId === item.categoryId)).slice().sort(byOrder);
  const i = group.findIndex(x => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= group.length) return;
  [group[i], group[j]] = [group[j], group[i]];
  await run(async () => {
    const batch = writeBatch(db);
    group.forEach((x, idx) => { if (x.order !== idx) batch.update(doc(db, kind === "category" ? "categories" : "lessons", x.id), { order: idx }); });
    await batch.commit();
    await reload(false);
  });
}
async function loadAdmin() {
  if (!isAdmin) return;
  refreshCategoryOptions();
  renderBrandAdmin();
  const orphans = lessons.filter(l => !categories.some(c => c.id === l.categoryId));
  const TYPE_LABEL = { mp3: "MP3 聆聽學習", nutrition: "營養課程" };
  $("adminContentList").innerHTML = ["mp3", "nutrition"].map(type => {
    const cats = categories.filter(c => c.type === type); if (!cats.length) return "";
    return `<p class="eyebrow" style="margin:18px 0 6px">${TYPE_LABEL[type]}</p>` + cats.map((c, ci) => {
      const ls = lessons.filter(l => l.categoryId === c.id), forced = c.type === "nutrition";
      return `<div class="admin-item"><div><b>${esc(c.name)}</b><small>${TYPE_LABEL[type]} · ${ls.length} 個單元 · ${forced || c.requiresApproval ? "需審核" : "開放"}</small></div><div class="admin-actions">${moveBtns("category", c.id, ci, cats.length)}${forced ? "" : `<button class="mini-btn" data-togglecat="${esc(c.id)}">${c.requiresApproval ? "改為開放" : "設為審核"}</button>`}<button class="mini-btn danger" data-delcat="${esc(c.id)}">刪除</button></div></div>${ls.map((l, li) => adminLessonRow(l, li, ls.length)).join("")}`;
    }).join("");
  }).join("") + (orphans.length ? `<div class="admin-item"><div><b>未分類內容（分類已被刪除）</b><small>這些內容學員看不到，可在此刪除</small></div></div>${orphans.map(l => adminLessonRow(l)).join("")}` : "")
    || "<div class='empty-state'>尚未建立分類。</div>";
  const box = $("adminContentList");
  box.querySelectorAll("[data-move]").forEach(b => b.onclick = () => { const [kind, id, dir] = b.dataset.move.split(":"); moveItem(kind, id, Number(dir)); });
  box.querySelectorAll("[data-togglecat]").forEach(b => b.onclick = () => run(async () => {
    const c = categories.find(x => x.id === b.dataset.togglecat);
    await updateDoc(doc(db, "categories", c.id), { requiresApproval: !c.requiresApproval }); await reload(false);
  }));
  box.querySelectorAll("[data-delcat]").forEach(b => b.onclick = async () => {
    const id = b.dataset.delcat, n = lessons.filter(l => l.categoryId === id).length;
    if (!confirm(`刪除此分類${n ? `，以及分類內的 ${n} 個學習內容` : ""}？此動作無法復原。`)) return;
    await run(async () => {
      const snap = await getDocs(query(collection(db, "lessons"), where("categoryId", "==", id)));
      const acc = await getDocs(query(collection(db, "categoryAccess"), where("categoryId", "==", id))); // 一併清掉這個分類的申請紀錄
      const refs = [...snap.docs, ...acc.docs].map(d => d.ref);
      for (let i = 0; i < refs.length; i += 400) { const batch = writeBatch(db); refs.slice(i, i + 400).forEach(r => batch.delete(r)); await batch.commit(); }
      await deleteDoc(doc(db, "categories", id)); await reload(false);
    }, "分類已刪除");
  });
  box.querySelectorAll("[data-dellesson]").forEach(b => b.onclick = async () => {
    if (!confirm("確定刪除此學習內容？")) return;
    await run(async () => { await deleteDoc(doc(db, "lessons", b.dataset.dellesson)); await reload(false); }, "學習內容已刪除");
  });

  box.querySelectorAll("[data-editlesson]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.editlesson; if (box.querySelector(`[data-editform="${id}"]`)) return;
    const l = lessons.find(x => x.id === id); if (!l) return;
    const cur = l.type === "mp3" ? (driveIdOf(l.mediaId) ? `https://drive.google.com/file/d/${l.mediaId}/view` : l.mediaId) : `https://youtu.be/${l.mediaId}`;
    const row = btn.closest(".admin-item");
    row.insertAdjacentHTML("afterend", `<form class="form-stack edit-form" data-editform="${esc(id)}"><label>內容標題<input class="ef-title" required value="${esc(l.title)}"></label><label>內容說明<input class="ef-desc" value="${esc(l.description || "")}"></label><label>${l.type === "mp3" ? "MP3 來源連結" : "YouTube 連結"}<input class="ef-media" required value="${esc(cur)}"></label><div class="edit-actions"><button class="btn btn-primary btn-small">儲存</button><button type="button" class="btn btn-ghost btn-small ef-cancel">取消</button></div></form>`);
    const form = row.nextElementSibling;
    form.querySelector(".ef-cancel").onclick = () => form.remove();
    form.onsubmit = async e => {
      e.preventDefault();
      const title = form.querySelector(".ef-title").value.trim(), raw = form.querySelector(".ef-media").value;
      const mediaId = l.type === "mp3" ? parseMp3Source(raw) : parseYoutube(raw);
      if (!title) { toast("請輸入標題"); return; }
      if (!mediaId) { toast(l.type === "mp3" ? "無法辨識 MP3 來源" : "無法辨識 YouTube 連結"); return; }
      await run(async () => { await updateDoc(doc(db, "lessons", id), { title, description: form.querySelector(".ef-desc").value.trim(), mediaId }); await reload(false); }, "已更新");
    };
  });

  // 書本
  $("adminBookList").innerHTML = books.map(b => { const cv = safeCover(b.cover); return `<div class="admin-item"><div class="admin-book"><div class="admin-thumb">${cv ? `<img src="${esc(cv)}" alt="">` : "◫"}</div><div><b>${esc(b.title)}</b><small>${b.requiresApproval ? "需審核" : "開放"}</small></div></div><div class="admin-actions"><button class="mini-btn" data-editbook="${esc(b.id)}">編輯</button><button class="mini-btn danger" data-delbook="${esc(b.id)}">刪除</button></div></div>`; }).join("") || "<div class='empty-state'>尚未新增書本。</div>";
  const bbox = $("adminBookList");
  bbox.querySelectorAll("[data-delbook]").forEach(btn => btn.onclick = async () => {
    if (!confirm("確定刪除這本書？")) return;
    await run(async () => { await deleteDoc(doc(db, "books", btn.dataset.delbook)); await reload(false); }, "書本已刪除");
  });
  bbox.querySelectorAll("[data-editbook]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.editbook; if (bbox.querySelector(`[data-editform="${id}"]`)) return;
    const b = books.find(x => x.id === id); if (!b) return;
    const row = btn.closest(".admin-item");
    row.insertAdjacentHTML("afterend", `<form class="form-stack edit-form" data-editform="${esc(id)}"><label>書名<input class="ef-title" required value="${esc(b.title)}"></label><label>簡介<input class="ef-desc" value="${esc(b.description || "")}"></label><label>FlipHTML5 連結<input class="ef-link" required value="${esc(b.link)}"></label><label>更換封面（不選則維持原封面）<input class="ef-file" type="file" accept="image/*"></label><label class="check-row"><input class="ef-appr" type="checkbox" ${b.requiresApproval ? "checked" : ""}> 需要審核會員才能閱讀</label><div class="edit-actions"><button class="btn btn-primary btn-small">儲存</button><button type="button" class="btn btn-ghost btn-small ef-cancel">取消</button></div></form>`);
    const form = row.nextElementSibling;
    form.querySelector(".ef-cancel").onclick = () => form.remove();
    form.onsubmit = async e => {
      e.preventDefault();
      const title = form.querySelector(".ef-title").value.trim(), link = parseFlip(form.querySelector(".ef-link").value);
      if (!title) { toast("請輸入書名"); return; }
      if (!link) { toast("無法辨識 FlipHTML5 連結：請貼 https://online.fliphtml5.com/... 或嵌入碼"); return; }
      await run(async () => {
        const f = form.querySelector(".ef-file").files[0];
        const cover = f ? await fileToCover(f) : (b.cover || "");
        await updateDoc(doc(db, "books", id), { title, description: form.querySelector(".ef-desc").value.trim(), link, cover, requiresApproval: form.querySelector(".ef-appr").checked });
        await reload(false);
      }, "書本已更新");
    };
  });

  // 公告
  $("announcementAdminList").innerHTML = announcements.map(a => `<div class="admin-item"><div><b>${esc(a.title)}</b><small>${esc(a.body)}</small></div><button class="mini-btn danger" data-delannounce="${esc(a.id)}">刪除</button></div>`).join("");
  $("announcementAdminList").querySelectorAll("[data-delannounce]").forEach(b => b.onclick = async () => {
    if (!confirm("確定刪除這則公告？")) return;
    await run(async () => { await deleteDoc(doc(db, "announcements", b.dataset.delannounce)); await reload(false); }, "公告已刪除");
  });

  // 分類進入申請
  try {
    const snap = await getDocs(collection(db, "categoryAccess"));
    const catOf = r => categories.find(c => c.id === r.categoryId);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(catOf);
    const pend = rows.filter(r => r.status !== "approved").sort((x, y) => secs(x.requestedAt) - secs(y.requestedAt));
    const appr = rows.filter(r => r.status === "approved").sort((x, y) => catOf(x).name.localeCompare(catOf(y).name) || String(x.name || x.email).localeCompare(String(y.name || y.email)));
    const when = t => secs(t) ? new Date(secs(t) * 1000).toLocaleString("zh-TW", { hour12: false }) : "";
    $("accessPendingCount").textContent = pend.length + " 待處理";
    $("accessPending").innerHTML = pend.length ? pend.map(r => `<div class="member-row"><div><b>${esc(r.name || "未提供名稱")}　→　${esc(catOf(r).name)}</b><small>${esc(r.email || "")} · 申請於 ${esc(when(r.requestedAt))}</small></div><div class="admin-actions"><button class="btn btn-primary btn-small" data-grant="${esc(r.id)}">核准</button><button class="mini-btn danger" data-deny="${esc(r.id)}">拒絕</button></div></div>`).join("") : "<div class='empty-state'>目前沒有待審核的申請。</div>";
    $("accessApproved").innerHTML = appr.map(r => `<div class="member-row"><div><b>${esc(r.name || "會員")}　→　${esc(catOf(r).name)}</b><small>${esc(r.email || "")}</small></div><button class="mini-btn danger" data-revokeaccess="${esc(r.id)}">撤銷</button></div>`).join("") || "<div class='empty-state'>尚無已核准的分類權限。</div>";
    $("accessPending").querySelectorAll("[data-grant]").forEach(b => b.onclick = () => run(async () => { await updateDoc(doc(db, "categoryAccess", b.dataset.grant), { status: "approved", approvedAt: serverTimestamp() }); await loadAdmin(); }, "已核准進入該分類"));
    $("accessPending").querySelectorAll("[data-deny]").forEach(b => b.onclick = async () => {
      if (!confirm("拒絕這項申請？對方之後可以重新申請。")) return;
      await run(async () => { await deleteDoc(doc(db, "categoryAccess", b.dataset.deny)); await loadAdmin(); }, "已拒絕申請");
    });
    $("accessApproved").querySelectorAll("[data-revokeaccess]").forEach(b => b.onclick = async () => {
      if (!confirm("撤銷此會員進入該分類的權限？對方之後需重新申請。")) return;
      await run(async () => { await deleteDoc(doc(db, "categoryAccess", b.dataset.revokeaccess)); await loadAdmin(); }, "已撤銷分類權限");
    });
  } catch (e) { console.error(e); $("accessPending").innerHTML = "<div class='empty-state'>讀取申請失敗：" + esc(e.code || e.message) + "（請確認 Firestore Rules 已發布最新版）</div>"; }

  // 舊制會員審核（目前只用於「需審核的書本」）
  try {
    const users = await getDocs(collection(db, "users")); const pending = [], approved = [];
    users.forEach(d => { const u = { id: d.id, ...d.data() }; if (u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) return; (u.status === "approved" ? approved : pending).push(u); });
    const byName = (a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email));
    pending.sort(byName); approved.sort(byName);
    $("pendingCount").textContent = pending.length + " 待處理";
    $("pendingMembers").innerHTML = pending.length ? pending.map(u => `<div class="member-row"><div><b>${esc(u.name || "未提供名稱")}</b><small>${esc(u.email || "")}</small></div><button class="btn btn-primary btn-small" data-approve="${esc(u.id)}">核准會員</button></div>`).join("") : "<div class='empty-state'>目前沒有待審核會員。</div>";
    $("approvedMembers").innerHTML = approved.map(u => `<div class="member-row"><div><b>${esc(u.name || "會員")}</b><small>${esc(u.email || "")}</small></div><button class="mini-btn danger" data-revoke="${esc(u.id)}">撤銷</button></div>`).join("") || "<div class='empty-state'>尚無已核准會員。</div>";
    $("pendingMembers").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => run(async () => { await updateDoc(doc(db, "users", b.dataset.approve), { status: "approved", approvedAt: serverTimestamp() }); await loadAdmin(); }, "會員已核准"));
    $("approvedMembers").querySelectorAll("[data-revoke]").forEach(b => b.onclick = async () => {
      if (!confirm("撤銷此會員的審核資格？")) return;
      await run(async () => { await updateDoc(doc(db, "users", b.dataset.revoke), { status: "pending" }); await loadAdmin(); }, "已撤銷會員資格");
    });
  } catch (e) { console.error(e); $("pendingMembers").innerHTML = "<div class='empty-state'>讀取會員失敗：" + esc(e.code || e.message) + "</div>"; }
}
$("reloadAdminContent").onclick = () => run(() => reload(false), "已重新整理");
document.querySelectorAll("[data-admin-tab]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-admin-tab]").forEach(x => x.classList.toggle("active", x === b));
  document.querySelectorAll(".admin-pane").forEach(x => x.classList.add("hidden"));
  $("admin-" + b.dataset.adminTab).classList.remove("hidden");
});
// 封面圖片：在瀏覽器內縮小成最長邊 420px 的 JPEG，直接存進 Firestore（免費、不需要 Firebase Storage）
function fileToCover(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 420 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let out = c.toDataURL("image/jpeg", 0.8); if (out.length > 300000) out = c.toDataURL("image/jpeg", 0.6);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("無法讀取這張圖片")); };
    img.src = url;
  });
}
let bookCoverData = "";
$("bookCoverFile").addEventListener("change", async () => {
  const f = $("bookCoverFile").files[0], pv = $("bookCoverPreview"); bookCoverData = "";
  if (!f) { pv.classList.add("hidden"); return; }
  try { bookCoverData = await fileToCover(f); pv.src = bookCoverData; pv.classList.remove("hidden"); } catch (e) { toast(e.message); }
});
$("bookForm").onsubmit = async e => {
  e.preventDefault();
  const title = $("bookTitle").value.trim(), link = parseFlip($("bookLink").value), url = $("bookCoverUrl").value.trim();
  if (!title) { toast("請輸入書名"); return; }
  if (!link) { toast("無法辨識 FlipHTML5 連結：請貼 https://online.fliphtml5.com/... 或嵌入碼"); return; }
  if (url && !/^https:\/\//i.test(url)) { toast("封面網址必須是 https 開頭"); return; }
  const form = e.target;
  await run(async () => {
    await addDoc(collection(db, "books"), { title, description: $("bookDesc").value.trim(), link, cover: bookCoverData || url, requiresApproval: $("bookApproval").checked, createdAt: serverTimestamp() });
    form.reset(); bookCoverData = ""; $("bookCoverPreview").classList.add("hidden"); await reload(false);
  }, "書本已新增");
};
$("announcementForm").onsubmit = async e => {
  e.preventDefault(); const form = e.target;
  await run(async () => {
    await addDoc(collection(db, "announcements"), { title: $("announcementTitle").value.trim(), body: $("announcementBody").value.trim(), createdAt: serverTimestamp() });
    form.reset(); await reload(false);
  }, "公告已發布");
};
applyLessonTypeUI();

/* ───────────── 品牌 Logo ───────────── */
// Logo 存在 Firestore settings/branding（logo＝網站內顯示用、icon＝192px 圖示），任何人（含未登入）可讀，只有管理員可寫。
const BRAND_KEY = "unfinished.branding.v1";
const okImg = s => typeof s === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(s) && s.length < 700000;
const DEFAULT_FAVICON = $("favicon")?.getAttribute("href") || "";
let branding = null, pendingBrand = null;
function applyBranding(b) {
  branding = b && okImg(b.logo) && okImg(b.icon) ? { logo: b.logo, icon: b.icon } : null;
  document.querySelectorAll("[data-logo]").forEach(el => {
    if (branding) { el.classList.add("has-logo"); el.innerHTML = `<img src="${branding.logo}" alt="Unfinished">`; }
    else { el.classList.remove("has-logo"); el.textContent = el.dataset.logo; }
  });
  const fl = $("footLogo"); if (fl) { if (branding) fl.src = branding.logo; fl.classList.toggle("hidden", !branding); }
  const fav = $("favicon"); if (fav) { fav.setAttribute("href", branding ? branding.icon : DEFAULT_FAVICON); fav.setAttribute("type", branding ? "image/png" : "image/svg+xml"); }
  let touch = document.querySelector("link[rel='apple-touch-icon']");
  if (branding) { if (!touch) { touch = document.createElement("link"); touch.rel = "apple-touch-icon"; document.head.appendChild(touch); } touch.href = branding.icon; }
  else touch?.remove();
  if ($("admin-branding")) renderBrandAdmin();
}
function cacheBranding(b) { try { b ? localStorage.setItem(BRAND_KEY, JSON.stringify({ logo: b.logo, icon: b.icon })) : localStorage.removeItem(BRAND_KEY); } catch (_) { /* 忽略 */ } }
async function loadBranding() {
  if (!db) return;
  try { const s = await getDoc(doc(db, "settings", "branding")); const b = s.exists() ? s.data() : null; applyBranding(b); cacheBranding(branding); }
  catch (e) { console.warn("讀取 Logo 失敗（Firestore Rules 可能尚未更新）", e.code); }
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("無法讀取這張圖片")); };
    img.src = url;
  });
}
// 產生兩個尺寸：logo（最長邊 ≤512，保留透明）與 icon（192×192 置中、留白）
async function fileToBranding(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error("圖片太大，請選擇小於 8 MB 的檔案");
  const img = await loadImage(file), w0 = img.naturalWidth || 512, h0 = img.naturalHeight || 512, isSvg = file.type === "image/svg+xml";
  let logo = "";
  for (const side of [512, 384, 256]) {
    const s = isSvg ? side / Math.max(w0, h0) : Math.min(1, side / Math.max(w0, h0));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    logo = c.toDataURL("image/png"); if (logo.length > 450000) logo = c.toDataURL("image/webp", 0.9);
    if (logo.length <= 450000) break;
  }
  if (logo.length > 600000) throw new Error("圖片過於複雜，請換一張較簡單或較小的圖");
  const ic = document.createElement("canvas"); ic.width = ic.height = 192;
  const s2 = Math.min((192 - 28) / w0, (192 - 28) / h0), iw = w0 * s2, ih = h0 * s2;
  ic.getContext("2d").drawImage(img, (192 - iw) / 2, (192 - ih) / 2, iw, ih);
  return { logo, icon: ic.toDataURL("image/png") };
}
function saveDataUrl(href, name) { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
async function downloadOg() {
  const src = (pendingBrand || branding)?.logo; if (!src) return;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const c = document.createElement("canvas"); c.width = 1200; c.height = 630; const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, 1200, 630); bg.addColorStop(0, "#101827"); bg.addColorStop(1, "#1d2d47"); g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
  const s = Math.min(560 / img.width, 300 / img.height), w = img.width * s, h = img.height * s;
  g.drawImage(img, (1200 - w) / 2, 110 + (300 - h) / 2, w, h);
  g.fillStyle = "#fff"; g.textAlign = "center"; g.font = "700 64px 'DM Sans','Noto Sans TC',sans-serif"; g.fillText("Unfinished", 600, 510);
  g.fillStyle = "#c9a45e"; g.font = "500 26px 'DM Sans','Noto Sans TC',sans-serif"; g.fillText("LEARNING HUB", 600, 560);
  c.toBlob(b => { const u = URL.createObjectURL(b); saveDataUrl(u, "og-image.png"); setTimeout(() => URL.revokeObjectURL(u), 3000); }, "image/png");
}
function renderBrandAdmin() {
  const cur = pendingBrand || branding, show = (id, src) => { const el = $(id); if (!el) return; if (src) el.src = src; el.classList.toggle("hidden", !src); };
  show("pvLogoLight", cur?.logo); show("pvLogoDark", cur?.logo); show("pvIcon", cur?.icon);
  $("pvNone").classList.toggle("hidden", !!cur);
  $("brandSave").disabled = !pendingBrand;
  ["dlFavicon", "dlOg", "dlLogo"].forEach(id => $(id).disabled = !cur);
}
$("brandFile").addEventListener("change", async () => {
  const f = $("brandFile").files[0]; pendingBrand = null;
  if (f) { try { pendingBrand = await fileToBranding(f); } catch (e) { toast(e.message || "無法處理這張圖片"); $("brandFile").value = ""; } }
  renderBrandAdmin();
});
$("brandForm").onsubmit = async e => {
  e.preventDefault(); if (!pendingBrand) return;
  const b = pendingBrand;
  const ok = await run(async () => {
    await setDoc(doc(db, "settings", "branding"), { logo: b.logo, icon: b.icon, updatedAt: serverTimestamp() });
    pendingBrand = null; $("brandFile").value = ""; applyBranding(b); cacheBranding(b);
  }, "Logo 已更新並套用到全站");
  if (ok) renderBrandAdmin();
};
$("brandReset").onclick = async () => {
  if (!branding && !pendingBrand) { toast("目前沒有自訂 Logo"); return; }
  if (!confirm("移除自訂 Logo，還原成預設的「U」圖示？")) return;
  await run(async () => { await deleteDoc(doc(db, "settings", "branding")); pendingBrand = null; $("brandFile").value = ""; applyBranding(null); cacheBranding(null); }, "已還原預設 Logo");
};
$("dlFavicon").onclick = () => { const c = pendingBrand || branding; if (c) saveDataUrl(c.icon, "favicon.png"); };
$("dlLogo").onclick = () => { const c = pendingBrand || branding; if (c) saveDataUrl(c.logo, "logo.png"); };
$("dlOg").onclick = () => downloadOg().catch(() => toast("產生縮圖失敗"));
try { applyBranding(JSON.parse(localStorage.getItem(BRAND_KEY) || "null")); } catch (_) { /* 忽略 */ }
loadBranding();
