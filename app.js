import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, getDocs, query, where, orderBy, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { esc, secs, fmtTime, parseYoutube, parseMp3Source, audioSrc, driveIdOf, driveSources } from "./helpers.js";

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
let categories = [], lessons = [], progressMap = {}, notes = [], announcements = [];
let currentCategory = null, currentView = "home";
let activeLesson = null, audioEl = null, ytPlayer = null, ytTimer = null, lastSaveAt = 0, lastSavedPos = -1;

/* ───────────── 小工具 ───────────── */
let toastTimer;
const toast = msg => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200); };
const dateText = () => new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
const isAdminUser = u => !!u?.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
const isApproved = () => isAdmin || profile?.status === "approved";
const categoryAllowed = c => isAdmin || ((!c.requiresApproval || isApproved()) && (c.type !== "nutrition" || isApproved()));
const progressFor = id => progressMap[id] || { percent: 0, completed: false, position: 0 };
const catName = id => categories.find(c => c.id === id)?.name || "未分類";
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
  const [p, c, pr, n, a] = await Promise.all([
    getDoc(doc(db, "users", uid)),
    getDocs(query(collection(db, "categories"), orderBy("createdAt", "asc"))),
    getDocs(collection(db, "users", uid, "progress")),
    getDocs(collection(db, "users", uid, "notes")),
    getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc")))
  ]);
  if (p.exists()) profile = p.data();
  else {
    const base = { email: currentUser.email, name: currentUser.displayName || "", photoURL: currentUser.photoURL || "", status: "pending", createdAt: serverTimestamp() };
    await setDoc(doc(db, "users", uid), base);
    profile = { ...base, createdAt: nowStamp() };
  }
  categories = c.docs.map(d => ({ id: d.id, ...d.data() }));
  // 管理員一次讀全部；其他人只查詢「有權進入的分類」，這樣才符合 Firestore Rules。
  let snaps;
  if (isAdmin) snaps = [await getDocs(query(collection(db, "lessons"), orderBy("createdAt", "asc")))];
  else snaps = await Promise.all(
    categories.filter(cat => categoryAllowed(cat))
      .map(cat => getDocs(query(collection(db, "lessons"), where("categoryId", "==", cat.id))).catch(e => { console.warn("讀取分類課程失敗", cat.id, e.code); return null; }))
  );
  lessons = snaps.filter(Boolean).flatMap(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  lessons.sort((x, y) => secs(x.createdAt) - secs(y.createdAt)); // 非管理員查詢沒有排序，這裡統一依新增時間排序
  progressMap = {}; pr.forEach(d => progressMap[d.id] = d.data());
  notes = n.docs.map(d => ({ id: d.id, ...d.data() }));
  announcements = a.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderShell(reset) {
  $("loginScreen").classList.add("hidden"); $("appShell").classList.remove("hidden");
  $("userName").textContent = currentUser.displayName || "學習者"; $("userEmail").textContent = currentUser.email;
  $("userAvatar").textContent = (currentUser.displayName || "U").slice(0, 1).toUpperCase();
  $("dateLabel").textContent = dateText().toUpperCase();
  $("adminNavWrap").classList.toggle("hidden", !isAdmin);
  const approved = isApproved();
  $("approvalBanner").classList.toggle("hidden", approved);
  if (!approved) $("approvalBanner").textContent = "你的帳號已完成登入，目前狀態為「待審核」。管理員核准後，請按右上角 ↻ 重新整理，即可使用營養課程及需審核的 MP3 分類。一般開放分類仍可正常學習。";
  if (reset) { currentView = "home"; currentCategory = null; }
  setView(currentView, !reset);
}

// 讀取資料並重畫目前畫面（管理員新增／刪除後不會被踢回首頁）
async function reload(reset = false) { await loadAll(); renderShell(reset); }

const VIEW_TITLES = { home: "學習總覽", mp3: "MP3 聆聽學習", nutrition: "營養課程", notes: "我的筆記", admin: "管理員後台" };
function setView(name, keep = false) {
  if (name === "admin" && !isAdmin) name = "home";
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("view-" + name)?.classList.remove("hidden");
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $("pageTitle").textContent = VIEW_TITLES[name] || "學習中心";
  if (name === "home") renderHome();
  else if (name === "mp3" || name === "nutrition") {
    const box = $(name === "mp3" ? "mp3Lessons" : "nutritionLessons");
    const stillOpen = keep && currentCategory && !box.classList.contains("hidden") && categories.some(c => c.id === currentCategory.id);
    if (stillOpen) openCategory(currentCategory.id); else renderCategories(name);
  }
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
  closeModal(true);
  currentUser = null; isAdmin = false; profile = null; categories = []; lessons = []; progressMap = {}; notes = []; announcements = []; currentCategory = null; currentView = "home";
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
    || lessons.slice(-3).reverse().map(l => `<div class="new-row"><div class="lesson-thumb">${l.type === "mp3" ? "♫" : "✧"}</div><div class="lesson-row-main"><b>${esc(l.title)}</b><small>${esc(catName(l.categoryId))}</small></div><span class="new-badge">NEW</span></div>`).join("")
    || "<div class='empty-state'>目前沒有新課程。</div>";
  $("homeCategories").innerHTML = ["mp3", "nutrition"].map(type => categoryCardHtml(categories.filter(c => c.type === type && categoryAllowed(c)), true)).join("") || "<div class='empty-state'>目前沒有可瀏覽的分類。</div>";
  bindCategoryCards();
  $("continueList").querySelectorAll("[data-open]").forEach(b => b.onclick = () => openLesson(b.dataset.open));
}
function categoryCardHtml(list, quiet) {
  return list.map(c => `<article class="category-card" data-category="${esc(c.id)}"><div class="category-icon">${c.type === "mp3" ? "♫" : "✧"}</div><h3>${esc(c.name)}</h3><p>${esc(c.description || "依照主題循序學習，累積知識與實戰能力。")}</p><div class="category-meta"><span>${lessons.filter(l => l.categoryId === c.id).length} 個單元</span><span>${c.requiresApproval || c.type === "nutrition" ? "審核專區" : "開放學習"}　→</span></div></article>`).join("")
    || (quiet ? "" : "<div class='empty-state'>目前沒有可瀏覽的分類。</div>");
}
function bindCategoryCards() { document.querySelectorAll("[data-category]").forEach(el => el.onclick = () => openCategory(el.dataset.category)); }
function renderCategories(type) {
  currentCategory = null;
  const list = categories.filter(c => c.type === type && categoryAllowed(c));
  const target = $(type === "mp3" ? "mp3Categories" : "nutritionCategories");
  target.classList.remove("hidden"); $(type === "mp3" ? "mp3Lessons" : "nutritionLessons").classList.add("hidden");
  let html = categoryCardHtml(list);
  const lockedCount = categories.filter(c => c.type === type && !categoryAllowed(c)).length;
  if (!isApproved() && lockedCount) {
    const note = `<div class="empty-state" style="grid-column:1/-1">🔒 ${type === "nutrition" ? "營養課程" : `另有 ${lockedCount} 個分類`}需要管理員審核通過後才能進入。核准後請按右上角 ↻ 重新整理。</div>`;
    html = list.length ? html + note : note;
  }
  target.innerHTML = html; bindCategoryCards();
}
function openCategory(id) {
  const c = categories.find(x => x.id === id); if (!c) return;
  if (!categoryAllowed(c)) { toast("此分類需要管理員審核通過"); return; }
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
  $("modalContent").innerHTML = `<p class="eyebrow">${isMp3 ? "AUDIO LEARNING" : "NUTRITION COURSE"} · ${esc(c.name)}</p><h2>${esc(l.title)}</h2><p class="muted" style="font-size:12px">${esc(l.description || "")}</p><div class="media-frame ${isMp3 ? "audio" : ""}" id="mediaFrame">${isMp3 ? `<audio id="audioPlayer" controls preload="metadata" playsinline src="${esc(audioSrc(l.mediaId))}"></audio>` : `<div id="youtubePlayer"></div>`}</div><p id="mediaError" class="error-text hidden"></p><div class="panel-heading"><div><b style="font-size:12px">本單元進度</b><div class="progress-track lesson-progress-track"><i id="lessonProgressBar" style="width:${p.completed ? 100 : (p.percent || 0)}%"></i></div></div><span id="lessonProgressText" class="status-pill ${p.completed ? "done" : ""}">${p.completed ? "✓ 已完成" : (p.percent || 0) + "%"}</span></div><div class="note-editor"><label>我的學習筆記<textarea id="lessonNote" rows="5" maxlength="20000" placeholder="記錄重點、案例、未來分享時可以使用的說法..."></textarea></label><div class="note-actions"><small class="muted">筆記只會儲存在你的帳號內。</small><button id="saveNote" class="btn btn-primary btn-small">儲存筆記</button></div></div>`;
  $("lessonModal").classList.remove("hidden"); document.body.classList.add("modal-open");
  $("lessonNote").value = notes.find(n => n.lessonId === id)?.content || "";
  $("saveNote").onclick = () => saveNote(id);
  if (isMp3) setupAudio(p); else setupYoutube(l, p);
}
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
      showDrivePreview(id); return;
    }
    showMediaError("音檔無法播放：請確認網址可直接開啟播放（https 直連 mp3）。");
  });
}
function showDrivePreview(id) {
  const lessonId = activeLesson?.id; if (!lessonId) return;
  audioEl = null;
  $("mediaFrame").classList.remove("audio");
  $("mediaFrame").innerHTML = `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(id)}/preview" allow="autoplay" style="width:100%;height:100%;border:0"></iframe>`;
  const e = $("mediaError");
  e.innerHTML = `已改用 Google Drive 內建播放器。此模式無法自動記錄進度與續播，聽完後請按：<button id="markDone" class="btn btn-primary btn-small" style="margin-left:8px">標記為已完成</button>`;
  e.classList.remove("hidden");
  $("markDone").onclick = () => completeLesson(lessonId);
}

function setupYoutube(l, p) {
  const videoId = parseYoutube(l.mediaId);
  if (!videoId) { showMediaError("這個課程的 YouTube 連結無法辨識，請管理員重新新增。"); return; }
  const start = !p.completed && p.position > 3 ? Math.floor(p.position) : 0;
  let tries = 0;
  const stopTicker = () => { if (ytTimer) { clearInterval(ytTimer); ytTimer = null; } };
  const wait = () => {
    if (!activeLesson || activeLesson.id !== l.id) return; // 視窗已關閉
    if (window.YT && window.YT.Player) {
      ytPlayer = new YT.Player("youtubePlayer", {
        videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, start, origin: location.origin },
        events: {
          onStateChange: e => {
            if (e.data === 1) { stopTicker(); ytTimer = setInterval(() => snapshotProgress(false), 1000); } // 播放中：每秒更新畫面，節流寫入
            else if (e.data === 2) { stopTicker(); snapshotProgress(true); }                                  // 暫停：立即存
            else if (e.data === 0) { stopTicker(); completeLesson(l.id); }                                    // 播完
          },
          onError: e => showMediaError([101, 150, 153].includes(e.data) ? "這支影片不允許嵌入播放，請管理員改用允許嵌入的影片。" : [100].includes(e.data) ? "找不到這支影片（可能已刪除或設為私人）。" : "影片無法播放（代碼 " + e.data + "）。")
        }
      });
    } else if (++tries > 40) showMediaError("YouTube 播放器載入失敗：請檢查網路，或關閉會阻擋 youtube.com 的廣告攔截器後重新整理。");
    else setTimeout(wait, 300);
  };
  wait();
}

function closeModal(silent) {
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
document.addEventListener("keydown", e => { if (e.key === "Escape" && activeLesson) closeModal(); });
// 手機切到背景、鎖屏、關閉分頁時，盡量把最後進度存起來
document.addEventListener("visibilitychange", () => { if (document.hidden) snapshotProgress(true); });
window.addEventListener("pagehide", () => snapshotProgress(true));

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
const adminLessonRow = l => `<div class="admin-item" style="padding-left:25px"><div><b>${esc(l.title)}</b><small>${l.type === "mp3" ? "MP3" : "YouTube"}</small></div><button class="mini-btn danger" data-dellesson="${esc(l.id)}">刪除內容</button></div>`;
async function loadAdmin() {
  if (!isAdmin) return;
  refreshCategoryOptions();
  const orphans = lessons.filter(l => !categories.some(c => c.id === l.categoryId));
  $("adminContentList").innerHTML = categories.map(c => {
    const ls = lessons.filter(l => l.categoryId === c.id), forced = c.type === "nutrition";
    return `<div class="admin-item"><div><b>${esc(c.name)}</b><small>${c.type === "mp3" ? "MP3" : "營養課程"} · ${ls.length} 個單元 · ${forced || c.requiresApproval ? "需審核" : "開放"}</small></div><div class="admin-actions">${forced ? "" : `<button class="mini-btn" data-togglecat="${esc(c.id)}">${c.requiresApproval ? "改為開放" : "設為審核"}</button>`}<button class="mini-btn danger" data-delcat="${esc(c.id)}">刪除</button></div></div>${ls.map(adminLessonRow).join("")}`;
  }).join("") + (orphans.length ? `<div class="admin-item"><div><b>未分類內容（分類已被刪除）</b><small>這些內容學員看不到，可在此刪除</small></div></div>${orphans.map(adminLessonRow).join("")}` : "")
    || "<div class='empty-state'>尚未建立分類。</div>";
  const box = $("adminContentList");
  box.querySelectorAll("[data-togglecat]").forEach(b => b.onclick = () => run(async () => {
    const c = categories.find(x => x.id === b.dataset.togglecat);
    await updateDoc(doc(db, "categories", c.id), { requiresApproval: !c.requiresApproval }); await reload(false);
  }));
  box.querySelectorAll("[data-delcat]").forEach(b => b.onclick = async () => {
    const id = b.dataset.delcat, n = lessons.filter(l => l.categoryId === id).length;
    if (!confirm(`刪除此分類${n ? `，以及分類內的 ${n} 個學習內容` : ""}？此動作無法復原。`)) return;
    await run(async () => {
      const snap = await getDocs(query(collection(db, "lessons"), where("categoryId", "==", id)));
      const refs = snap.docs.map(d => d.ref);
      for (let i = 0; i < refs.length; i += 400) { const batch = writeBatch(db); refs.slice(i, i + 400).forEach(r => batch.delete(r)); await batch.commit(); }
      await deleteDoc(doc(db, "categories", id)); await reload(false);
    }, "分類已刪除");
  });
  box.querySelectorAll("[data-dellesson]").forEach(b => b.onclick = async () => {
    if (!confirm("確定刪除此學習內容？")) return;
    await run(async () => { await deleteDoc(doc(db, "lessons", b.dataset.dellesson)); await reload(false); }, "學習內容已刪除");
  });

  // 公告
  $("announcementAdminList").innerHTML = announcements.map(a => `<div class="admin-item"><div><b>${esc(a.title)}</b><small>${esc(a.body)}</small></div><button class="mini-btn danger" data-delannounce="${esc(a.id)}">刪除</button></div>`).join("");
  $("announcementAdminList").querySelectorAll("[data-delannounce]").forEach(b => b.onclick = async () => {
    if (!confirm("確定刪除這則公告？")) return;
    await run(async () => { await deleteDoc(doc(db, "announcements", b.dataset.delannounce)); await reload(false); }, "公告已刪除");
  });

  // 會員審核
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
$("announcementForm").onsubmit = async e => {
  e.preventDefault(); const form = e.target;
  await run(async () => {
    await addDoc(collection(db, "announcements"), { title: $("announcementTitle").value.trim(), body: $("announcementBody").value.trim(), createdAt: serverTimestamp() });
    form.reset(); await reload(false);
  }, "公告已發布");
};
applyLessonTypeUI();
