import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendEmailVerification, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, collection, query, where, orderBy, limit,
  getDocs, getCountFromServer, onSnapshot, writeBatch, serverTimestamp, Timestamp, updateDoc, deleteField,
  deleteDoc, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ------------------------------------------------------------------ state & helpers
let user = null;      // Firebase Auth user
let profile = null;   // own Firestore profile
let claims = {};      // custom claims (admin)
let guest = null;     // guest record when signed in anonymously
let cleanups = [];    // listeners to detach on route change
let busy = false;     // true while registering, to avoid re-rendering mid-flow
let pendingFlash = null;
const nameCache = {};

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "");
const render = (html) => { el("app").innerHTML = html; };
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const verifyUrl = () => location.origin + location.pathname;


// ---- nearby: location is stored only as a coarse ~5 km grid cell (gx, gy), never exact coordinates
const hasCell = (o) => o && Number.isInteger(o.gx) && Number.isInteger(o.gy);
function distKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const la1 = rad(a.gx / 20), la2 = rad(b.gx / 20), dLa = la2 - la1, dLo = rad((b.gy - a.gy) / 20);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distLabel(km) {
  for (const x of [5, 10, 25, 50, 100, 250]) if (km <= x) return `Within ${x} km`;
  return "More than 250 km away";
}

// ---- presence: a member counts as "online" if their lastSeen heartbeat is under 7 minutes old (refreshed every 3 minutes)
const ONLINE_MS = 7 * 60 * 1000, BEAT_MS = 3 * 60 * 1000;
let presenceTimer = null;
const presenceHidden = () => { try { return localStorage.getItem("desire_hide_online") === "1"; } catch (_) { return false; } };
async function beat() {
  if (!user || user.isAnonymous || !user.emailVerified || !profile || presenceHidden() || document.hidden) return;
  try { await updateDoc(doc(db, "users", user.uid), { lastSeen: serverTimestamp() }); } catch (_) {}
}
function startPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  if (!user || user.isAnonymous || !profile) return;
  beat();
  presenceTimer = setInterval(beat, BEAT_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });

function ageOf(d) {
  const t = new Date();
  let a = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

function flash(msg, type = "error") {
  el("flash").innerHTML = msg ? `<div class="flash ${type}">${esc(msg)}</div>` : "";
  if (msg) window.scrollTo(0, 0);
}

function friendly(err) {
  const c = err && err.code ? err.code : "";
  const map = {
    "auth/email-already-in-use": "That email is already registered.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/weak-password": "Password must be at least 8 characters.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "Incorrect email or password.",
    "auth/user-disabled": "This account has been suspended.",
    "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
    "permission-denied": "Not allowed. Check that you are 18+, your account is in good standing and all fields are valid.",
  };
  return map[c] || (err && err.message) || "Something went wrong.";
}

function cleanup() { cleanups.forEach((f) => { try { f(); } catch (_) {} }); cleanups = []; }

async function nameOf(uid) {
  if (!(uid in nameCache)) {
    try {
      const s = await getDoc(doc(db, "users", uid));
      if (s.exists()) nameCache[uid] = s.data().name;
      else {
        let g = await getDoc(doc(db, "guestNames", uid));
        if (!g.exists() && claims.admin) g = await getDoc(doc(db, "guests", uid));
        nameCache[uid] = g.exists() ? `${g.data().nickname} (guest)` : "(deleted)";
      }
    } catch (_) { nameCache[uid] = "(unavailable)"; }
  }
  return nameCache[uid];
}

async function loadSession(u) {
  user = u; profile = null; guest = null; claims = {};
  if (!u) return;
  if (u.isAnonymous) {
    try {
      const g = await getDoc(doc(db, "guests", u.uid));
      guest = g.exists() ? { id: g.id, ...g.data() } : null;
    } catch (_) {}
    if (guest && guest.banned) {
      pendingFlash = "This guest session has been suspended.";
      user = null; guest = null;
      await signOut(auth);
    }
    return;
  }
  try { claims = (await u.getIdTokenResult()).claims; } catch (_) {}
  try {
    const s = await getDoc(doc(db, "users", u.uid));
    profile = s.exists() ? { id: s.id, ...s.data() } : null;
  } catch (_) {}
  if (profile && profile.banned) {      // suspended members are signed straight out
    pendingFlash = "This account has been suspended.";
    user = null; profile = null; claims = {};
    await signOut(auth);
  }
}

function requireLogin() {
  if (!user) { go("#/login"); return false; }
  return true;
}
function requireVerified() {
  if (!requireLogin()) return false;
  if (user.isAnonymous) {
    render(`<div class="card narrow"><h2>Members only</h2>
      <p>Swiping is for members. Create a free account to unlock Discover, likes, matches and pictures.</p>
      <p><a class="btn" href="#/register">Sign up</a> <a class="btn ghost" href="#/online">See who is online</a></p></div>`);
    return false;
  }
  if (!user.emailVerified) { go("#/verify"); return false; }
  return true;
}

// Pages that guests may use too (everything except Discover).
function requireChatter() {
  if (!requireLogin()) return false;
  if (user.isAnonymous) {
    if (!guest) { go("#/guest"); return false; }
    return true;
  }
  return requireVerified();
}
const selfRecord = () => (user.isAnonymous ? guest : profile);


// ------------------------------------------------------------------ icons & small helpers
const ICONS = {
  flame: "M2 12C4.5 9.2 7 7.2 9.2 7.4C10.6 7.5 11.4 8.2 12 9C12.6 8.2 13.4 7.5 14.8 7.4C17 7.2 19.5 9.2 22 12C19 12.9 15.5 13.2 12 13.2C8.5 13.2 5 12.9 2 12ZM2.6 13C5.6 13.8 8.8 14.1 12 14.1C15.2 14.1 18.4 13.8 21.4 13C20 16.6 16.5 18.8 12 18.8C7.5 18.8 4 16.6 2.6 13Z",
  heart: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  chat: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
  person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  people: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  shuffle: "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
  send: "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z",
  image: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  more: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  pin: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z",
  star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;
const LOADING_LINES = ["Fixing our lipstick…", "Batting our eyelashes…", "Finding someone cute…", "Warming things up…", "Playing it cool… almost there", "Checking who's online 👀"];
const loadingHtml = (line) => `<div class="loading">${ic("flame")}<p>${line || LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)]}</p></div>`;
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
const pairId = (a, b) => [a, b].sort().join("_");
const ago = (ms) => {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d";
};
const isOnline = (p) => !!(p && p.lastSeen && p.lastSeen.toMillis && p.lastSeen.toMillis() > Date.now() - ONLINE_MS && !p.banned);
const dot = (p) => (isOnline(p) ? '<i class="on" title="Online"></i>' : "");
const avatar = (p, size = "") => {
  const d = isOnline(p) ? "<i class=\"on\"></i>" : "";
  return p && p.thumb
    ? `<span class="av ${size}"><img src="${esc(p.thumb)}" alt="">${d}</span>`
    : `<span class="av ph ${size}">${esc(((p && p.name) || "?").slice(0, 1).toUpperCase())}${d}</span>`;
};

const INTERESTS = ["Travel", "Music", "Movies", "Fitness", "Foodie", "Reading", "Gaming", "Cooking", "Dancing",
  "Photography", "Art", "Pets", "Hiking", "Cricket", "Football", "Yoga", "Coffee", "Road trips"];
const GOALS = { long: "A long-term partner", short: "Something casual", friends: "New friends", open: "Still figuring it out" };

// user lookups (members and guests), cached for a minute
const userCache = new Map();
async function getUser(uid, force) {
  const c = userCache.get(uid);
  if (c && !force && Date.now() - c.t < 60000) return c.data;
  let data = null;
  try {
    const s = await getDoc(doc(db, "users", uid));
    if (s.exists()) data = { id: uid, kind: "member", ...s.data() };
    else {
      const g = await getDoc(doc(db, "guestNames", uid));
      if (g.exists()) data = { id: uid, kind: "guest", name: g.data().nickname };
    }
  } catch (_) {}
  userCache.set(uid, { t: Date.now(), data });
  return data;
}

// ------------------------------------------------------------------ pictures (stored as small JPEGs inside Firestore; no Storage plan needed)
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read that file.")); r.readAsDataURL(f); });
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read that image.")); i.src = src; });
async function imageFrom(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error("Please choose a picture file.");
  return loadImg(await readFile(file));
}
function canvasOf(img, w, h, cover) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  if (cover) {
    const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
    x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
  } else x.drawImage(img, 0, 0, w, h);
  return c;
}
function fitJpeg(img, maxSide, maxChars) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = canvasOf(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), false);
  for (let q = 0.84; q >= 0.35; q -= 0.07) {
    const u = c.toDataURL("image/jpeg", q);
    if (u.length <= maxChars) return u;
  }
  throw new Error("That picture is too detailed to upload. Try another one.");
}
const thumbOf = (img) => canvasOf(img, 360, 480, true).toDataURL("image/jpeg", 0.72);

// ------------------------------------------------------------------ conversations (live, for the Messages badge and inbox)
let convs = new Map(), convUnsub = null, convFor = null, convsReady = Promise.resolve();
const convListeners = new Set();
const convStatus = (c) => (c ? c.status || "accepted" : null);
const incomingRequests = () => [...convs.values()].filter((c) => convStatus(c) === "request" && c.initiator && c.initiator !== user.uid);
function updateBadge() {
  const b = document.getElementById("reqbadge");
  if (!b || !user) return;
  const n = incomingRequests().length;
  b.textContent = n; b.hidden = !n;
}
function stopConvs() {
  if (convUnsub) { convUnsub(); convUnsub = null; }
  convs = new Map(); convFor = null;
}
function ensureConvs() {
  const ok = user && ((user.isAnonymous && guest) || (!user.isAnonymous && user.emailVerified && profile));
  if (!ok) { if (convUnsub) stopConvs(); return; }
  if (convFor === user.uid) return;
  stopConvs();
  convFor = user.uid;
  convsReady = new Promise((res) => {
    convUnsub = onSnapshot(
      query(collection(db, "conversations"), where("participants", "array-contains", user.uid), limit(200)),
      (snap) => {
        convs = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data({ serverTimestamps: "estimate" }) }]));
        updateBadge();
        convListeners.forEach((f) => { try { f(); } catch (_) {} });
        res();
      },
      () => res(),
    );
  });
}

// ------------------------------------------------------------------ nav & router
function renderNav(page, arg) {
  document.body.classList.toggle("out", !user);
  document.body.classList.toggle("wide", page === "admin");
  document.body.dataset.page = page;
  document.body.dataset.full = ((page === "chat" && arg) || page === "profile") ? "1" : "0";
  const t = (href, icon, label, on, extra = "") => `<a href="${href}" class="${on ? "on" : ""}" aria-label="${label}" title="${label}">${ic(icon)}${extra}</a>`;
  const msgOn = page === "chat" || page === "requests";
  const msgTab = t("#/chat", "chat", "Messages", msgOn, '<b class="bdg" id="reqbadge" hidden></b>');
  el("tabs").innerHTML = !user ? ""
    : user.isAnonymous
      ? t("#/online", "people", "Online", page === "online") + t("#/random", "shuffle", "Random", page === "random") + msgTab + t("#/register", "person", "Sign up", false)
      : t("#/browse", "heart", "Discover", page === "browse") + t("#/online", "people", "Online", page === "online")
        + t("#/random", "shuffle", "Random", page === "random") + msgTab + t("#/me", "person", "Profile", page === "me");
  el("nav").innerHTML = !user ? '<a href="#/login">Log in</a>'
    : user.isAnonymous ? '<a class="btn sm" href="#/register">Sign up</a>' : "";
  updateBadge();
}

async function route() {
  cleanup();
  flash("");
  if (pendingFlash) { flash(pendingFlash, "warn"); pendingFlash = null; }
  ensureConvs();
  const [, page = "", arg = ""] = (location.hash || "#/").split("/");
  renderNav(page, arg);
  window.scrollTo(0, 0);
  if (user && !user.isAnonymous && profile && !presenceTimer) startPresence();
  try {
    switch (page) {
      case "": return pageHome();
      case "terms": return pageTerms();
      case "register": return pageRegister();
      case "login": return pageLogin();
      case "verify": return pageVerify();
      case "guest": return await pageGuest();
      case "lobby": return go("#/online");
      case "browse": return await pageBrowse();
      case "online": return await pageOnline();
      case "random": return await pageRandom();
      case "profile": return await pageProfile(arg);
      case "me": return arg === "edit" ? await pageEdit() : await pageMe();
      case "chat": return arg ? await pageChat(arg) : await pageInbox("chats");
      case "requests": return await pageInbox("requests");
      case "admin": return await pageAdmin(arg);
      default: return render('<div class="empty"><h3>Page not found</h3><a href="#/">Go home</a></div>');
    }
  } catch (err) {
    console.error(err);
    flash(friendly(err));
  }
}

window.addEventListener("hashchange", route);
onAuthStateChanged(auth, async (u) => {
  await loadSession(u);
  if (!u) stopConvs();
  startPresence();
  if (!busy) route();
});

// ------------------------------------------------------------------ public pages
function pageHome() {
  if (user && !user.isAnonymous) return go("#/browse");
  if (user && user.isAnonymous && guest) return go("#/online");
  render(`<section class="landing"><div>
    <div class="brand">${ic("flame")}desire</div>
    <h1>Feeling a little curious? 😉</h1>
    <p class="sub2">Real people. Real chemistry. Zero catfish.</p>
    <div class="perks">
      <div class="perk">${ic("check")}<div><b>Adults only</b><span>18+ only, because things get interesting</span></div></div>
      <div class="perk">${ic("person")}<div><b>Real people</b><span>Everyone is verified, so no catfish</span></div></div>
      <div class="perk">${ic("heart")}<div><b>You set the pace</b><span>Slow burn or fast spark, your call</span></div></div>
    </div>
    <a class="btn big" href="#/register">Join the fun</a>
    <a class="btn ghost big" href="#/login">I'm already hooked</a>
    <p><a class="link" href="#/guest">Continue as guest</a></p>
    <p class="fine">By continuing you confirm you are 18 or older and accept our <a href="#/terms">Terms</a>.</p>
  </div></section>`);
}

function pageTerms() {
  render(`<div class="card"><h2>Terms &amp; Privacy (summary)</h2><ul>
    <li>You must be 18 or older. Accounts found to belong to minors are removed.</li>
    <li>Everything must be consensual. Harassment, pressure, threats, or sharing someone's content without permission lead to a ban.</li>
    <li>No payment solicitation, scams, escorting or commercial sex offers, and no illegal content. Photos must show you and must not be explicit.</li>
    <li><b>Message requests:</b> a first message arrives as a request. Until the other person accepts, you can send two messages. They can accept, decline or block you.</li>
    <li><b>Message moderation:</b> private messages are not end-to-end encrypted. Authorised moderators may review a conversation to investigate reports, enforce these rules and keep members safe. Each access requires a written reason and is recorded in an audit log.</li>
    <li><b>Guests</b> (no email) can use Online, blind chat and message requests, but cannot like, browse everyone, or send pictures. They must confirm they are 18+ and follow the same rules.</li>
    <li>We store your email, profile details, photos and messages to run the service. Your email is never shown to other members.</li>
    <li><b>Blind chat:</b> random chat pairs you with an anonymous person of the opposite gender. These conversations are stored and may be reviewed by moderators like any other message.</li>
    <li><b>Online status:</b> other members can see that you are online while you have the site open. Turn this off any time in Profile.</li>
    <li><b>Location (optional):</b> if you tap "Use my location", we save only a rough area about 5 km wide. Others see a range such as "Within 10 km", never your exact position.</li>
    <li>Meet in public first, tell a friend where you are going, and practise safer sex.</li></ul>
    <p class="muted">Replace this summary with a full policy reviewed by a lawyer before launch.</p></div>`);
}

// ------------------------------------------------------------------ auth pages
function pageRegister() {
  if (user && !user.isAnonymous) return go("#/browse");
  const maxDate = new Date().toISOString().slice(0, 10);
  render(`
  <div class="card narrow"><h2>Create your account</h2>
  <form id="f" autocomplete="on">
    <div class="row">
      <div><label>Name / nickname</label><input name="name" required maxlength="40"></div>
      <div><label>Date of birth</label><input type="date" name="dob" required max="${maxDate}"></div>
    </div>
    <label>Email (required, used to unlock chat)</label>
    <input type="email" name="email" required maxlength="254">
    <div class="row">
      <div><label>Password (min 8 characters)</label><input type="password" name="password" required minlength="8"></div>
      <div><label>Confirm password</label><input type="password" name="password2" required minlength="8"></div>
    </div>
    <div class="row">
      <div><label>I am</label><select name="gender" required><option value="">Choose…</option><option value="male">Male</option><option value="female">Female</option></select></div>
      <div><label>Looking for</label><select name="lookingFor" required><option value="">Choose…</option><option value="male">Men</option><option value="female">Women</option></select></div>
    </div>
    <label>City</label><input name="city" required maxlength="60">
    <label>About you (optional, max 500 characters)</label><textarea name="bio" maxlength="500"></textarea>
    <label class="check"><input type="checkbox" name="adult" value="1"><span>I confirm that I am 18 years of age or older.</span></label>
    <label class="check"><input type="checkbox" name="terms" value="1"><span>I accept the <a href="#/terms" target="_blank">Terms</a>, including that messages may be reviewed by moderators for safety and to handle reports.</span></label>
    <button type="submit" id="submit">Create account</button>
    <p class="muted">Already a member? <a href="#/login">Log in</a></p>
  </form></div>`);

  el("f").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target).entries());
    const errors = [];
    v.name = (v.name || "").trim(); v.city = (v.city || "").trim(); v.bio = (v.bio || "").trim();
    v.email = (v.email || "").trim();
    const dob = new Date(`${v.dob}T00:00:00Z`);
    if (v.name.length < 2 || v.name.length > 40) errors.push("Name must be 2-40 characters.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errors.push("A valid email address is required.");
    if ((v.password || "").length < 8) errors.push("Password must be at least 8 characters.");
    if (v.password !== v.password2) errors.push("Passwords do not match.");
    if (isNaN(dob) || ageOf(dob) < 18) errors.push("You must be at least 18 years old.");
    if (!["male", "female"].includes(v.gender) || !["male", "female"].includes(v.lookingFor)) errors.push("Please choose your gender and who you are looking for.");
    if (v.city.length < 2) errors.push("Please enter your city.");
    if (!v.adult) errors.push("You must confirm you are 18 or older.");
    if (!v.terms) errors.push("You must accept the Terms, including safety moderation of messages.");
    if (errors.length) return flash(errors.join(" "));

    const btn = el("submit"); btn.disabled = true; busy = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, v.email, v.password);
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "users", cred.user.uid), {
          name: v.name, dob: Timestamp.fromDate(dob), gender: v.gender, lookingFor: v.lookingFor,
          city: v.city, bio: v.bio, adultConfirmed: true,
          consentAt: serverTimestamp(), createdAt: serverTimestamp(), banned: false, hidden: false,
        });
        batch.set(doc(db, "userPrivate", cred.user.uid), { email: cred.user.email });
        await batch.commit();
      } catch (err) {
        await cred.user.delete();   // don't leave an account without a valid profile
        throw err;
      }
      try { await sendEmailVerification(cred.user, { url: verifyUrl() }); } catch (_) {}
      await loadSession(cred.user);
      busy = false;
      go("#/verify");
    } catch (err) {
      busy = false; btn.disabled = false;
      flash(friendly(err));
    }
  };
}

function pageLogin() {
  if (user && !user.isAnonymous) return go("#/browse");
  render(`<div class="card narrow small"><h2>Well, hello again 😉</h2><p class="muted flirt">We missed you. Log in and see who's been thinking about you.</p><form id="f">
    <label>Your email</label><input type="email" name="email" required placeholder="you@gorgeous.com">
    <label>Secret password</label><input type="password" name="password" required>
    <p><button type="submit">Let me in 💋</button></p>
    <p class="muted">New here? <a href="#/register">Come say hi, create an account</a></p></form></div>`);
  el("f").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const cred = await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value);
      await loadSession(cred.user);
      if (user) go(user.emailVerified ? "#/browse" : "#/verify");   // user is null if suspended
    } catch (err) { flash(friendly(err)); }
  };
}

async function checkVerified(silent) {
  await user.reload();
  if (user.emailVerified) {
    await user.getIdToken(true);       // refresh token so rules see email_verified = true
    await loadSession(user);
    go(profile && profile.thumb ? "#/browse" : "#/me/edit");
  } else if (!silent) {
    flash("Not verified yet. Click the link in the email we sent, then try again.", "warn");
  }
}

function pageVerify() {
  if (!requireLogin()) return;
  if (user.isAnonymous) return go("#/online");
  if (user.emailVerified) return go("#/browse");
  render(`<div class="card narrow"><h2>Check your email</h2>
    <p>We sent a confirmation link to <b>${esc(user.email)}</b>. Click it to start matching.
    Check your spam folder if you don't see it.</p>
    <p><button id="check">I've verified, continue</button>
    <button class="ghost" id="resend">Resend email</button></p></div>`);
  el("check").onclick = () => checkVerified(false).catch((e) => flash(friendly(e)));
  el("resend").onclick = async () => {
    try { await sendEmailVerification(user, { url: verifyUrl() }); flash("Verification email sent.", "ok"); }
    catch (e) { flash(friendly(e)); }
  };
  const onVis = () => { if (document.visibilityState === "visible") checkVerified(true).catch(() => {}); };
  document.addEventListener("visibilitychange", onVis);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
}


// ------------------------------------------------------------------ likes & matches
const passedMap = () => { try { return JSON.parse(lsGet("desire_pass", "{}")) || {}; } catch (_) { return {}; } };
function markPassed(id) {
  const m = passedMap(), now = Date.now();
  for (const k of Object.keys(m)) if (now - m[k] > 3 * 86400000) delete m[k];   // passes expire after 3 days
  m[id] = now;
  lsSet("desire_pass", JSON.stringify(m));
}

function showMatch(p) {
  const d = document.createElement("div");
  d.className = "match";
  d.innerHTML = `<h1>It's a match!</h1><p>You and ${esc(p.name)} liked each other.</p>
    <div class="pair">${avatar(profile, "xl")}${avatar(p, "xl")}</div>
    <a class="btn" href="#/chat/${esc(p.id)}">Send a message</a><button class="ghost" id="keep" style="color:#fff;border-color:#fff">Keep swiping</button>`;
  document.body.appendChild(d);
  const close = () => d.remove();
  d.querySelector("#keep").onclick = close;
  d.querySelector("a").onclick = close;
  cleanups.push(close);
}

// Returns true when it is a match.
async function doLike(p) {
  try {
    const q = await getDocs(query(collection(db, "likes"), where("to", "==", user.uid), where("from", "==", p.id), limit(1)));
    const mutual = !q.empty;
    const batch = writeBatch(db);
    batch.set(doc(db, "likes", `${user.uid}_${p.id}`), { from: user.uid, to: p.id, createdAt: serverTimestamp() });
    if (mutual) {                       // a match skips the message-request step
      await convsReady;
      const cid = pairId(user.uid, p.id), c = convs.get(cid), ref = doc(db, "conversations", cid);
      if (!c) batch.set(ref, { participants: [user.uid, p.id].sort(), updatedAt: serverTimestamp(), initiator: user.uid, status: "accepted", reqCount: 0 });
      else if (convStatus(c) !== "accepted") batch.update(ref, { status: "accepted", updatedAt: serverTimestamp() });
    }
    await batch.commit();
    if (mutual) showMatch(p);
    return mutual;
  } catch (err) {
    flash(friendly(err));
    return false;
  }
}

// ------------------------------------------------------------------ discover (swipe deck)
function cardHtml(p, top) {
  const where = p.km != null ? distLabel(p.km) : p.city;
  return `<div class="tcard ${top ? "top" : "back"}" data-id="${esc(p.id)}">
    ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" draggable="false">` : `<div class="ph big">${esc(p.name.slice(0, 1).toUpperCase())}</div>`}
    <div class="stamp like">LIKE</div><div class="stamp nope">NOPE</div><div class="shade"></div>
    <div class="meta"><h2>${esc(p.name)} <span>${ageOf(p.dob.toDate())}</span>${dot(p)}</h2>
    <p>${ic("pin")}${esc(where)}</p>${p.job ? `<p>${esc(p.job)}</p>` : ""}</div></div>`;
}

function bindDrag(card, decide, onTap) {
  let sx = 0, sy = 0, dx = 0, dy = 0, down = false, moved = false;
  const like = card.querySelector(".stamp.like"), nope = card.querySelector(".stamp.nope");
  card.onpointerdown = (e) => { down = true; moved = false; sx = e.clientX; sy = e.clientY; dx = dy = 0; card.setPointerCapture(e.pointerId); card.style.transition = "none"; };
  card.onpointermove = (e) => {
    if (!down) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 8) moved = true;
    card.style.transform = `translate(${dx}px,${dy * 0.35}px) rotate(${dx / 18}deg)`;
    like.style.opacity = Math.max(0, Math.min(1, dx / 110));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 110));
  };
  card.onpointerup = card.onpointercancel = () => {
    if (!down) return;
    down = false; card.style.transition = "";
    if (!moved) return onTap();
    if (dx > 110) decide("like");
    else if (dx < -110) decide("pass");
    else { card.style.transform = ""; like.style.opacity = nope.style.opacity = 0; }
  };
}

async function pageBrowse() {
  if (!requireVerified()) return;
  if (!profile) return render('<div class="card"><p>No member profile found for this account.</p></div>');
  const geo = hasCell(profile), maxKm = Number(lsGet("desire_km", "0")) || 0;
  render(`${profile.thumb ? "" : '<a class="nudge" href="#/me/edit">Add a photo to get more matches</a>'}
    <div class="deckwrap"><div class="deck" id="deck"><div class="empty">${loadingHtml("Finding someone cute…")}</div></div>
    <div class="acts" id="acts"><button class="rb pass" id="bPass" aria-label="Pass">${ic("close")}</button>
      <button class="rb msg" id="bMsg" aria-label="Message">${ic("chat")}</button>
      <button class="rb like" id="bLike" aria-label="Like">${ic("heart")}</button></div></div>`);

  const [snap, blocks, likes] = await Promise.all([
    getDocs(query(collection(db, "users"),
      where("gender", "==", profile.lookingFor), where("lookingFor", "==", profile.gender),
      where("banned", "==", false), where("hidden", "==", false), limit(150))),
    getDocs(query(collection(db, "blocks"), where("blockerId", "==", user.uid))),
    getDocs(query(collection(db, "likes"), where("from", "==", user.uid), limit(500))),
  ]);
  const skip = new Set([...blocks.docs.map((d) => d.data().blockedId), ...likes.docs.map((d) => d.data().to), ...Object.keys(passedMap()), user.uid]);
  let list = snap.docs.filter((d) => !skip.has(d.id)).map((d) => {
    const p = { id: d.id, ...d.data() };
    p.km = geo && hasCell(p) ? distKm(profile, p) : null;
    return p;
  }).filter((p) => !maxKm || p.km == null || p.km <= maxKm);
  // online people first, then closest, with a little shuffle so the deck isn't always the same
  const score = (p) => (isOnline(p) ? 0 : 1000) + (p.km ?? 300) + Math.random() * 40;
  list = list.map((p) => ({ p, s: score(p) })).sort((a, b) => a.s - b.s).map((x) => x.p);

  let acting = false;
  const deck = el("deck");
  const paint = () => {
    if (!list.length) {
      el("acts").hidden = true;
      deck.innerHTML = `<div class="empty">${ic("flame")}<h3>No one new right now</h3>
        <p>Check back soon, or widen your distance in Profile.</p>
        <p><button id="again">Refresh</button></p></div>`;
      el("again").onclick = () => route();
      return;
    }
    el("acts").hidden = false;
    deck.innerHTML = list.slice(0, 2).reverse().map((p, i, a) => cardHtml(p, i === a.length - 1)).join("");
    bindDrag(deck.querySelector(".tcard.top"), decide, () => go(`#/profile/${list[0].id}`));
  };
  const decide = (dir) => {
    if (acting || !list.length) return;
    acting = true;
    const p = list[0], c = deck.querySelector(".tcard.top");
    c.querySelector(dir === "like" ? ".stamp.like" : ".stamp.nope").style.opacity = 1;
    c.style.transition = "transform .28s ease";
    c.style.transform = `translate(${(dir === "like" ? 1 : -1) * (window.innerWidth + 200)}px,-40px) rotate(${dir === "like" ? 25 : -25}deg)`;
    if (dir === "like") doLike(p); else markPassed(p.id);
    setTimeout(() => { list.shift(); acting = false; paint(); }, 280);
  };
  el("bPass").onclick = () => decide("pass");
  el("bLike").onclick = () => decide("like");
  el("bMsg").onclick = () => list.length && go(`#/chat/${list[0].id}`);
  paint();
}

// ------------------------------------------------------------------ someone's profile
async function pageProfile(uid) {
  if (!requireChatter()) return;
  const isGuest = user.isAnonymous, self = uid === user.uid;
  const s = await getDoc(doc(db, "users", uid));
  if (!s.exists() || s.data().banned || s.data().hidden) return render('<div class="empty"><h3>Profile not found</h3><a href="#/browse">Back</a></div>');
  const p = { id: uid, ...s.data() };
  let pics = [];
  try { const ph = await getDoc(doc(db, "photos", uid)); if (ph.exists()) pics = ph.data().p || []; } catch (_) {}
  if (!pics.length && p.thumb) pics = [p.thumb];
  const km = !isGuest && hasCell(profile) && hasCell(p) ? distKm(profile, p) : null;
  const sub = (icon, text) => (text ? `<p class="sub">${ic(icon)}${esc(text)}</p>` : "");
  let idx = 0;

  render(`<div class="pview">
    <div class="gal" id="gal"></div>
    <div class="pinfo">
      <h1>${esc(p.name)} <span>${ageOf(p.dob.toDate())}</span>${dot(p)}</h1>
      ${sub("person", [p.job, p.school].filter(Boolean).join(" · "))}
      ${sub("pin", (km != null ? distLabel(km) + " · " : "") + p.city)}
      ${isOnline(p) ? '<p class="sub" style="color:var(--ok)">Online now</p>' : ""}
      ${p.bio ? `<div class="sec"><h4>About</h4><p>${esc(p.bio)}</p></div>` : ""}
      ${p.goal && GOALS[p.goal] ? `<div class="sec"><h4>Looking for</h4><span class="chip sel">${esc(GOALS[p.goal])}</span></div>` : ""}
      ${(p.interests || []).length ? `<div class="sec"><h4>Interests</h4>${p.interests.map((i) => `<span class="chip">${esc(i)}</span>`).join("")}</div>` : ""}
      ${p.height ? `<div class="sec"><h4>Height</h4><p>${esc(p.height)} cm</p></div>` : ""}
      ${self ? `<div class="sec"><a class="btn big" href="#/me/edit">Edit profile</a></div>` : `<div class="sec">
        ${isGuest ? "" : '<button class="link" id="block">Block</button>'}<button class="link" id="report">Report</button></div>`}
    </div>
    ${self ? "" : `<div class="acts fixed"><button class="rb pass" id="bPass" aria-label="Pass">${ic("close")}</button>
      <button class="rb msg" id="bMsg" aria-label="Message">${ic("chat")}</button>
      ${isGuest ? "" : `<button class="rb like" id="bLike" aria-label="Like">${ic("heart")}</button>`}</div>`}
  </div>`);

  const drawGal = () => {
    el("gal").innerHTML = `<button class="gback" id="gback" aria-label="Back">${ic("back")}</button>
      ${pics.length > 1 ? `<div class="bars">${pics.map((_, i) => `<i class="${i === idx ? "cur" : ""}"></i>`).join("")}</div>
        <button class="tapL" id="tapL" aria-label="Previous photo"></button><button class="tapR" id="tapR" aria-label="Next photo"></button>` : ""}
      ${pics.length ? `<img src="${esc(pics[idx])}" alt="">` : `<div class="ph big">${esc(p.name.slice(0, 1).toUpperCase())}</div>`}`;
    el("gback").onclick = () => history.back();
    if (pics.length > 1) {
      el("tapL").onclick = () => { idx = (idx + pics.length - 1) % pics.length; drawGal(); };
      el("tapR").onclick = () => { idx = (idx + 1) % pics.length; drawGal(); };
    }
  };
  drawGal();
  if (self) return;

  el("bPass").onclick = () => { markPassed(uid); history.back(); };
  el("bMsg").onclick = () => go(`#/chat/${uid}`);
  if (el("bLike")) el("bLike").onclick = async () => { if (!(await doLike(p))) history.back(); };
  if (el("block")) el("block").onclick = async () => {
    if (!confirm("Block this person? They will no longer be able to message you.")) return;
    try {
      await setDoc(doc(db, "blocks", `${user.uid}_${uid}`), { blockerId: user.uid, blockedId: uid, createdAt: serverTimestamp() });
      go("#/browse");
    } catch (err) { flash(friendly(err)); }
  };
  el("report").onclick = async () => {
    const reason = (prompt("What went wrong? (sent to moderators)") || "").trim();
    if (!reason) return;
    try {
      await addDoc(collection(db, "reports"), { reporterId: user.uid, reportedId: uid, reason: reason.slice(0, 500), resolved: false, createdAt: serverTimestamp() });
      flash("Thanks, our moderators will review this report.", "ok");
    } catch (err) { flash(friendly(err)); }
  };
}

// ------------------------------------------------------------------ my profile (settings)
async function pageMe() {
  if (!requireVerified()) return;
  if (!profile) return render('<div class="card"><p>No member profile found for this account.</p></div>');
  const geo = hasCell(profile), km = Number(lsGet("desire_km", "0")) || 0;
  render(`<div class="me">
      <div class="ring">${avatar(profile, "xl")}</div>
      <h1>${esc(profile.name)}, ${ageOf(profile.dob.toDate())}</h1>
      <p class="muted">${esc(profile.city)}${profile.job ? " · " + esc(profile.job) : ""}</p>
      <div class="btnrow center"><a class="btn" href="#/me/edit">${ic("edit")} Edit profile</a><a class="btn ghost" href="#/profile/${esc(user.uid)}">Preview</a></div>
    </div>
    ${profile.thumb ? "" : '<a class="nudge" href="#/me/edit">Add your first photo</a>'}
    <div>
      <div class="li"><span>Show me as online</span><label class="switch"><input type="checkbox" id="showme"><i></i></label></div>
      <div class="li"><span>Show people within</span><select id="km">
        ${[[10, "10 km"], [25, "25 km"], [50, "50 km"], [100, "100 km"], [0, "Any distance"]].map(([v, l]) => `<option value="${v}" ${v === km ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="li"><span>${geo ? "Location shared (rough area only)" : "Show people near me"}</span>
        <span>${geo ? '<button class="link" id="locUpdate">Update</button> · <button class="link" id="locStop">Stop</button>' : '<button class="link" id="locUse">Use my location</button>'}</span></div>
      ${claims.admin ? '<a class="li" href="#/admin">Admin panel</a>' : ""}
      <a class="li" href="#/terms">Terms &amp; safety</a>
      <button class="li danger" id="logout2">Log out</button>
    </div>`);

  const showme = el("showme");
  showme.checked = !presenceHidden();
  showme.onchange = async () => {
    try {
      if (showme.checked) { localStorage.removeItem("desire_hide_online"); await beat(); }
      else { lsSet("desire_hide_online", "1"); await updateDoc(doc(db, "users", user.uid), { lastSeen: deleteField() }); }
    } catch (err) { flash(friendly(err)); }
  };
  el("km").onchange = (e) => lsSet("desire_km", e.target.value);
  el("logout2").onclick = async () => { await signOut(auth); go("#/"); };

  const share = () => {
    if (!navigator.geolocation) return flash("Your browser cannot share location.");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const gx = Math.round(pos.coords.latitude * 20), gy = Math.round(pos.coords.longitude * 20);
        await updateDoc(doc(db, "users", user.uid), { gx, gy });
        profile.gx = gx; profile.gy = gy;
        route();
      } catch (err) { flash(friendly(err)); }
    }, () => flash("Location was blocked or unavailable. Allow location for this site in your browser settings."),
    { maximumAge: 600000, timeout: 15000 });
  };
  if (el("locUse")) el("locUse").onclick = share;
  if (el("locUpdate")) el("locUpdate").onclick = share;
  if (el("locStop")) el("locStop").onclick = async () => {
    try {
      await updateDoc(doc(db, "users", user.uid), { gx: deleteField(), gy: deleteField() });
      delete profile.gx; delete profile.gy;
      route();
    } catch (err) { flash(friendly(err)); }
  };
}

// ------------------------------------------------------------------ edit profile (4 photos + details)
async function savePhotos(list) {
  const batch = writeBatch(db);
  batch.set(doc(db, "photos", user.uid), { p: list, updatedAt: serverTimestamp() });
  if (list.length) {
    const thumb = thumbOf(await loadImg(list[0]));
    batch.update(doc(db, "users", user.uid), { thumb });
    profile.thumb = thumb;
  } else {
    batch.update(doc(db, "users", user.uid), { thumb: deleteField() });
    delete profile.thumb;
  }
  await batch.commit();
}

async function pageEdit() {
  if (!requireVerified()) return;
  if (!profile) return render('<div class="card"><p>No member profile found for this account.</p></div>');
  let pics = [];
  try { const s = await getDoc(doc(db, "photos", user.uid)); if (s.exists()) pics = (s.data().p || []).slice(0, 4); } catch (_) {}
  const sel = new Set(profile.interests || []);
  render(`<div class="bar"><a class="icb" href="#/me" aria-label="Back">${ic("back")}</a><h2>Edit profile</h2><span style="width:40px"></span></div>
    <div class="pgrid" id="pgrid"></div>
    <input type="file" id="pick" accept="image/*" hidden>
    <p class="muted hint">Add up to 4 photos. The first one is your main photo.</p>
    <form id="f">
      <label>Name</label><input name="name" required minlength="2" maxlength="40">
      <label>About me</label><textarea name="bio" maxlength="500" placeholder="A little about you"></textarea>
      <label>Job title</label><input name="job" maxlength="60">
      <label>School</label><input name="school" maxlength="60">
      <div class="row keep"><div><label>City</label><input name="city" required minlength="2" maxlength="60"></div>
        <div><label>Height (cm)</label><input name="height" type="number" min="120" max="230" inputmode="numeric"></div></div>
      <label>I'm looking for</label>
      <select name="goal"><option value="">Prefer not to say</option>${Object.entries(GOALS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <label>Interests <span id="icount"></span></label><div id="chips"></div>
      <p><button type="submit" class="big" id="save">Save</button></p>
    </form>`);

  const f = el("f");
  f.name.value = profile.name || ""; f.bio.value = profile.bio || ""; f.job.value = profile.job || "";
  f.school.value = profile.school || ""; f.city.value = profile.city || ""; f.height.value = profile.height || "";
  f.goal.value = profile.goal || "";

  const drawChips = () => {
    el("chips").innerHTML = INTERESTS.map((i) => `<button type="button" class="chip ${sel.has(i) ? "sel" : ""}" data-i="${esc(i)}">${esc(i)}</button>`).join("");
    el("icount").textContent = `(${sel.size}/6)`;
  };
  el("chips").onclick = (e) => {
    const i = e.target.dataset.i;
    if (!i) return;
    if (sel.has(i)) sel.delete(i); else if (sel.size < 6) sel.add(i); else flash("You can pick up to 6 interests.", "warn");
    drawChips();
  };
  drawChips();

  let working = false;
  const drawSlots = () => {
    el("pgrid").innerHTML = [0, 1, 2, 3].map((i) => pics[i]
      ? `<div class="slot full"><img src="${esc(pics[i])}" alt="">${i === 0 ? '<span class="tag">Main</span>' : ""}
          <button type="button" class="mini x" data-rm="${i}" aria-label="Remove photo">${ic("close")}</button>
          ${i > 0 ? `<button type="button" class="mini star" data-main="${i}" aria-label="Make main photo">${ic("star")}</button>` : ""}</div>`
      : `<div class="slot"><button type="button" class="add" data-add="1" aria-label="Add photo">${ic("plus")}</button></div>`).join("");
  };
  const persist = async (next) => {
    if (working) return;
    working = true;
    try { await savePhotos(next); pics = next; }
    catch (err) { flash(friendly(err)); }
    working = false;
    drawSlots();
  };
  el("pgrid").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || working) return;
    if (b.dataset.add) el("pick").click();
    else if (b.dataset.rm !== undefined) persist(pics.filter((_, i) => i !== Number(b.dataset.rm)));
    else if (b.dataset.main !== undefined) { const i = Number(b.dataset.main), n = pics.slice(); [n[0], n[i]] = [n[i], n[0]]; persist(n); }
  };
  el("pick").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || pics.length >= 4 || working) return;
    try {
      flash("Uploading…", "warn");
      const u = fitJpeg(await imageFrom(file), 900, 190000);
      await persist([...pics, u]);
      flash("");
    } catch (err) { flash(friendly(err)); }
  };
  drawSlots();

  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = {
      name: f.name.value.trim(), bio: f.bio.value.trim(), city: f.city.value.trim(),
      job: f.job.value.trim(), school: f.school.value.trim(), goal: f.goal.value,
      height: f.height.value ? Math.round(Number(f.height.value)) : 0,
    };
    if (v.name.length < 2) return flash("Please enter your name.");
    if (v.city.length < 2) return flash("Please enter your city.");
    if (v.height && (v.height < 120 || v.height > 230)) return flash("Height must be between 120 and 230 cm.");
    const upd = {
      name: v.name, bio: v.bio, city: v.city,
      job: v.job || deleteField(), school: v.school || deleteField(),
      height: v.height || deleteField(), goal: v.goal || deleteField(),
      interests: sel.size ? [...sel] : deleteField(),
    };
    el("save").disabled = true;
    try {
      await updateDoc(doc(db, "users", user.uid), upd);
      Object.assign(profile, { name: v.name, bio: v.bio, city: v.city, job: v.job, school: v.school, height: v.height, goal: v.goal, interests: [...sel] });
      go("#/me");
    } catch (err) { el("save").disabled = false; flash(friendly(err)); }
  };
}

// ------------------------------------------------------------------ online now
async function pageOnline() {
  if (!requireChatter()) return;
  const isGuest = user.isAnonymous;
  if (!isGuest && !profile) return render('<div class="card"><p>No member profile found for this account.</p></div>');
  let who = "", people = [];
  render(`<div class="bar"><h2>Online now <i class="on"></i></h2></div>
    <div class="seg" id="seg"><button data-w="" class="act">Everyone</button><button data-w="female">Women</button><button data-w="male">Men</button></div>
    <div class="tiles" id="tiles">${loadingHtml("Checking who's online 👀")}</div>`);

  const draw = () => {
    const list = people.filter((p) => !who || p.gender === who).map((p) => ({
      ...p, km: !isGuest && hasCell(profile) && hasCell(p) ? distKm(profile, p) : null,
      same: !isGuest && String(p.city).trim().toLowerCase() === String(profile.city).trim().toLowerCase(),
    }));
    list.sort((a, b) => (b.same - a.same) || ((a.km ?? 1e9) - (b.km ?? 1e9)) || (b.lastSeen.toMillis() - a.lastSeen.toMillis()));
    el("tiles").innerHTML = list.map((p) => `<a class="tile" href="#/profile/${esc(p.id)}">
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : `<div class="ph big">${esc(p.name.slice(0, 1).toUpperCase())}</div>`}
      <div class="shade"></div><div class="meta"><h2>${esc(p.name)} <span>${ageOf(p.dob.toDate())}</span><i class="on"></i></h2>
      <p>${p.km != null ? distLabel(p.km) : esc(p.city)}</p></div></a>`).join("")
      || `<div class="empty" style="grid-column:1/-1"><h3>Nobody else is online</h3><p>Check back in a moment.</p></div>`;
  };
  const load = async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - ONLINE_MS);
    const [snap, blocks] = await Promise.all([
      getDocs(query(collection(db, "users"), where("lastSeen", ">=", cutoff), orderBy("lastSeen", "desc"), limit(150))),
      isGuest ? Promise.resolve({ docs: [] }) : getDocs(query(collection(db, "blocks"), where("blockerId", "==", user.uid))),
    ]);
    const blocked = new Set(blocks.docs.map((d) => d.data().blockedId));
    people = snap.docs.filter((d) => d.id !== user.uid && !blocked.has(d.id))
      .map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.banned && !p.hidden && p.lastSeen);
    draw();
  };
  el("seg").onclick = (e) => {
    if (e.target.dataset.w === undefined) return;
    who = e.target.dataset.w;
    el("seg").querySelectorAll("button").forEach((b) => b.classList.toggle("act", b === e.target));
    draw();
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 45000);
  cleanups.push(() => clearInterval(t));
}

// ------------------------------------------------------------------ messages (chats + requests)
async function pageInbox(tab) {
  if (!requireChatter()) return;
  render(`<div class="bar"><h2>Messages</h2></div>
    <div class="seg"><a href="#/chat" class="${tab === "chats" ? "act" : ""}">Chats</a><a href="#/requests" class="${tab === "requests" ? "act" : ""}">Requests</a></div>
    <div id="list">${loadingHtml("Opening your secret admirers…")}</div>`);
  let token = 0;
  const draw = async () => {
    const my = ++token;
    await convsReady;
    const all = [...convs.values()].map((c) => ({ ...c, st: convStatus(c), other: c.participants.find((p) => p !== user.uid) }));
    const incoming = all.filter((c) => c.st === "request" && c.initiator && c.initiator !== user.uid);
    const items = (tab === "requests" ? incoming
      : all.filter((c) => c.st === "accepted" || (c.st === "request" && c.initiator === user.uid)))
      .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    const users = await Promise.all(items.map((c) => getUser(c.other)));
    if (my !== token || !el("list")) return;
    const reqBanner = tab === "chats" && incoming.length
      ? `<a class="reqrow" href="#/requests"><div class="grow"><b>Message requests</b><span class="muted">People who want to chat with you</span></div><span class="cnt">${incoming.length}</span></a>` : "";
    el("list").innerHTML = reqBanner + items.map((c, i) => {
      const u = users[i] || { name: "(unavailable)" };
      const sub = c.st === "request" ? (c.initiator === user.uid ? "Request sent · waiting for a reply" : "Wants to chat with you")
        : isOnline(u) ? "Online now" : "Tap to chat";
      return `<a class="rowi" href="#/chat/${esc(c.other)}">${avatar(u)}<div class="grow"><b>${esc(u.name || "?")}${u.kind === "guest" ? " (guest)" : ""}</b>
        <span class="muted">${esc(sub)}</span></div><time>${esc(ago(c.updatedAt?.toMillis?.()))}</time></a>`;
    }).join("") || `<div class="empty">${ic("chat")}<h3>${tab === "requests" ? "No requests" : "No chats yet"}</h3>
      <p>${tab === "requests" ? "When someone you haven't matched with writes to you, it shows up here." : "Swipe, match, or say hi to someone online."}</p>
      <a class="btn" href="${user.isAnonymous ? "#/online" : "#/browse"}">${user.isAnonymous ? "See who is online" : "Start swiping"}</a></div>`;
  };
  convListeners.add(draw);
  cleanups.push(() => convListeners.delete(draw));
  draw();
}

async function pageChat(uid) {
  if (!requireChatter()) return;
  if (uid === user.uid) return go("#/chat");
  const other = await getUser(uid, true);
  if (!other || other.banned) return render('<div class="empty"><h3>This person is not available</h3><a href="#/chat">Back</a></div>');
  const meGuest = user.isAnonymous, canPic = !meGuest;
  const pair = [user.uid, uid].sort(), convId = pair.join("_");
  await convsReady;

  const whoInner = `${avatar(other)}<div><b>${esc(other.name)}${other.kind === "guest" ? " (guest)" : ""}</b><span class="muted" id="presence"></span></div>`;
  render(`<div class="chatpage">
    <div class="chead"><button class="icb" id="back" aria-label="Back">${ic("back")}</button>
      ${other.kind === "member" ? `<a class="who" href="#/profile/${esc(uid)}">${whoInner}</a>` : `<div class="who">${whoInner}</div>`}
      <button class="icb" id="more" aria-label="More">${ic("more")}</button></div>
    <div class="menu" id="menu" hidden>${meGuest ? "" : '<button id="mBlock">Block</button>'}<button id="mReport">Report</button></div>
    <div id="banner"></div>
    <div class="thread" id="thread"></div>
    <form id="send" class="composer">
      ${canPic ? `<button type="button" class="icb" id="pic" aria-label="Send a picture">${ic("image")}</button><input type="file" id="file" accept="image/*" hidden>` : ""}
      <textarea name="body" maxlength="2000" rows="1" placeholder="Write a message…"></textarea>
      <button type="submit" class="sendb" aria-label="Send">${ic("send")}</button></form></div>`);

  const ta = el("send").body;
  const setPresence = () => {
    const x = el("presence");
    if (!x) return;
    x.textContent = other.kind === "guest" ? "Guest" : isOnline(other) ? "Online now" : "";
    x.className = isOnline(other) ? "ok" : "muted";
  };
  setPresence();
  const pt = setInterval(async () => { const u = await getUser(uid, true); if (u) { Object.assign(other, u); setPresence(); } }, 60000);
  cleanups.push(() => clearInterval(pt));

  // ---- request state: banner + whether the composer is enabled
  const applyState = () => {
    const conv = convs.get(convId), st = convStatus(conv);
    const incoming = conv && st === "request" && conv.initiator && conv.initiator !== user.uid;
    const outgoing = conv && st === "request" && conv.initiator === user.uid;
    const declinedByMe = conv && st === "declined" && conv.initiator !== user.uid;
    const left = outgoing ? Math.max(0, 2 - (conv.reqCount || 1)) : 2;
    let html = "", can = true, ph = "Write a message…";
    if (!conv) html = `<div class="note">Your first message goes to ${esc(other.name)} as a request. You can send 2 until they accept.</div>`;
    else if (incoming) { html = `<div class="reqbox"><p><b>${esc(other.name)}</b> wants to chat with you.</p>
      <div class="btnrow"><button id="acc">Accept</button><button class="ghost" id="dec">Decline</button></div></div>`; ph = "Reply to accept…"; }
    else if (declinedByMe) { html = `<div class="reqbox"><p>You declined this request.</p><div class="btnrow"><button id="acc">Accept instead</button></div></div>`; can = false; }
    else if (st === "declined") { html = `<div class="note">Waiting for ${esc(other.name)} to accept. You can message again once they do.</div>`; can = false; }
    else if (outgoing) {
      html = left ? `<div class="note">Request sent · ${left} message${left > 1 ? "s" : ""} left until ${esc(other.name)} accepts.</div>`
        : `<div class="note">Waiting for ${esc(other.name)} to accept. You can message again once they do.</div>`;
      can = left > 0;
    }
    el("banner").innerHTML = html;
    ta.disabled = !can; ta.placeholder = can ? ph : "Waiting for them to accept…";
    el("send").querySelector(".sendb").disabled = !can;
    if (el("pic")) el("pic").disabled = !can;
    if (el("acc")) el("acc").onclick = async () => {
      try { await updateDoc(doc(db, "conversations", convId), { status: "accepted", updatedAt: serverTimestamp() }); }
      catch (err) { flash(friendly(err)); }
    };
    if (el("dec")) el("dec").onclick = async () => {
      try { await updateDoc(doc(db, "conversations", convId), { status: "declined" }); go("#/requests"); }
      catch (err) { flash(friendly(err)); }
    };
  };
  convListeners.add(applyState);
  cleanups.push(() => convListeners.delete(applyState));
  applyState();

  // ---- header menu
  el("back").onclick = () => (history.length > 1 ? history.back() : go("#/chat"));
  el("more").onclick = (e) => { e.stopPropagation(); el("menu").hidden = !el("menu").hidden; };
  const hideMenu = () => { const m = el("menu"); if (m) m.hidden = true; };
  document.addEventListener("click", hideMenu);
  cleanups.push(() => document.removeEventListener("click", hideMenu));
  if (el("mBlock")) el("mBlock").onclick = async () => {
    if (!confirm("Block this person?")) return;
    try {
      await setDoc(doc(db, "blocks", `${user.uid}_${uid}`), { blockerId: user.uid, blockedId: uid, createdAt: serverTimestamp() });
      go("#/chat");
    } catch (err) { flash(friendly(err)); }
  };
  el("mReport").onclick = async () => {
    const reason = (prompt("What went wrong? (sent to moderators)") || "").trim();
    if (!reason) return;
    try {
      await addDoc(collection(db, "reports"), {
        reporterId: user.uid, reportedId: uid, reason: `[Private chat ${convId}] ${reason}`.slice(0, 500), resolved: false, createdAt: serverTimestamp(),
      });
      flash("Thanks, moderators will review this report.", "ok");
    } catch (err) { flash(friendly(err)); }
  };

  // ---- messages
  const thread = el("thread");
  const q = query(collection(db, "conversations", convId, "messages"), orderBy("createdAt", "desc"), limit(200));
  const unsub = onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" })).reverse();
    thread.innerHTML = items.map((m) => `<div class="msg ${m.senderId === user.uid ? "mine" : ""}">${m.img ? `<img class="chatimg" src="${esc(m.img)}" alt="Picture">` : ""}${m.body ? esc(m.body) : ""}<small>${esc(m.createdAt ? m.createdAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")}</small></div>`).join("");
    thread.scrollTop = thread.scrollHeight;
  }, () => flash("Could not load messages."));
  cleanups.push(unsub);
  thread.onclick = (e) => {
    if (!e.target.classList.contains("chatimg")) return;
    const lb = document.createElement("div");
    lb.className = "lb";
    lb.innerHTML = `<img src="${esc(e.target.src)}" alt="">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
    cleanups.push(() => lb.remove());
  };

  // ---- sending: the conversation document is created/updated in the same batch as the message
  async function sendMsg(body, img) {
    const conv = convs.get(convId), st = convStatus(conv), ref = doc(db, "conversations", convId), ts = serverTimestamp();
    const batch = writeBatch(db);
    if (!conv) batch.set(ref, { participants: pair, updatedAt: ts, initiator: user.uid, status: "request", reqCount: 1 });
    else if (st === "request" && conv.initiator === user.uid) batch.update(ref, { updatedAt: ts, reqCount: (conv.reqCount || 1) + 1 });
    else if (st === "request") batch.update(ref, { status: "accepted", updatedAt: ts });   // replying accepts the request
    else batch.update(ref, { updatedAt: ts });
    const m = { senderId: user.uid, body, createdAt: ts };
    if (img) m.img = img;
    batch.set(doc(collection(db, "conversations", convId, "messages")), m);
    await batch.commit();
  }
  const submit = async () => {
    const body = ta.value.trim();
    if (!body || ta.disabled) return;
    ta.value = "";
    try { await sendMsg(body); }
    catch (err) { ta.value = body; flash("Message not sent. You may be blocked, or the request limit was reached."); }
  };
  el("send").onsubmit = (e) => { e.preventDefault(); submit(); };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } };
  if (el("pic")) {
    el("pic").onclick = () => el("file").click();
    el("file").onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        flash("Sending picture…", "warn");
        await sendMsg("", fitJpeg(await imageFrom(file), 900, 170000));
        flash("");
      } catch (err) { flash(err && err.code ? "Picture not sent. You may be blocked, or the request limit was reached." : friendly(err)); }
    };
  }
}

// ------------------------------------------------------------------ random blind chat (Omegle-style)
// Queue lives in Firestore (`waiting/{uid}`). Whoever searches claims one fresh, opposite-gender entry plus their
// own in a single transaction and creates a room. Firestore rules enforce the opposite-gender pairing.
const oppositeOf = (g) => (g === "male" ? "female" : "male");
const WAIT_FRESH_MS = 75 * 1000, WAIT_PING_MS = 20 * 1000, WAIT_TRY_MS = 4000;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function pageRandom() {
  if (!requireChatter()) return;
  const self = selfRecord();
  if (!self) return render('<div class="card"><p>No profile found for this account.</p></div>');
  if (!self.gender) {   // guest sessions created before gender existed
    render(`<div class="card narrow small"><h2>One quick thing</h2><p class="muted">Blind chat matches opposite genders, so tell us which you are.</p>
      <form id="g"><select name="gender" required><option value="">Choose…</option><option value="male">Male</option><option value="female">Female</option></select>
      <p><button type="submit">Continue</button></p></form></div>`);
    el("g").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await updateDoc(doc(db, "guests", user.uid), { gender: e.target.gender.value });
        guest.gender = e.target.gender.value;
        route();
      } catch (err) { flash(friendly(err)); }
    };
    return;
  }

  const myWait = doc(db, "waiting", user.uid);
  const wantLabel = self.gender === "male" ? "a woman" : "a man";
  const strangerLabel = self.gender === "male" ? "Woman" : "Man";
  let searching = false, matching = false, entering = false, room = null, myPing = 0;   // room = { id, other, ended }
  let pingT = null, tryT = null, unsubWait = null, unsubRoom = null, unsubMsgs = null, blocked = new Set();

  const stopSearch = async () => {
    searching = false;
    clearInterval(pingT); clearInterval(tryT); pingT = tryT = null;
    if (unsubWait) { unsubWait(); unsubWait = null; }
    try { await deleteDoc(myWait); } catch (_) {}
  };
  const leaveRoom = async () => {
    if (unsubRoom) { unsubRoom(); unsubRoom = null; }
    if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
    if (room && !room.ended) {
      room.ended = true;
      try { await updateDoc(doc(db, "rooms", room.id), { ended: true }); } catch (_) {}
    }
  };
  const teardown = () => { stopSearch(); leaveRoom(); };
  cleanups.push(teardown);
  const onHide = () => { if (searching || (room && !room.ended)) teardown(); };
  window.addEventListener("pagehide", onHide);
  cleanups.push(() => window.removeEventListener("pagehide", onHide));

  // ---------- screens
  const showIdle = (note) => render(`<div class="card narrow"><h2>&#127917; Blind chat</h2>
    <p>Get connected to a random, anonymous <b>${wantLabel === "a woman" ? "woman" : "man"}</b> who is also looking right now. No names, no photos, just conversation.
    If the vibe is good, keep talking. If not, tap <b>Next</b>.</p>
    ${note ? `<div class="flash warn">${esc(note)}</div>` : ""}
    <div class="notice">Be respectful. Never share contact details or money. Use <b>Report</b> if someone crosses a line.</div>
    <button id="start">Find someone</button></div>`);
  const bindIdle = () => { el("start").onclick = startSearch; };

  const showSearching = () => {
    render(`<div class="card narrow" style="text-align:center"><h2><span class="pulse"></span>Looking for ${wantLabel}…</h2>
      <p class="muted">Keep this page open. We'll connect you the moment someone of the opposite gender is waiting.</p>
      <p class="muted" id="sstat">Connecting to the queue…</p>
      <p class="muted" style="font-size:.75rem">blind chat build 5</p>
      <button class="ghost" id="cancel">Cancel</button></div>`);
    el("cancel").onclick = async () => { await stopSearch(); showIdle(); bindIdle(); };
  };

  const showRoom = () => {
    render(`<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
        <h3 style="margin:0">&#127917; Stranger <span class="badge">${strangerLabel}</span></h3>
        <span class="muted">Anonymous</span></div>
      <div class="thread" id="thread"></div>
      <form id="send" class="sendbar"><textarea name="body" required maxlength="1000" placeholder="Say hi…"></textarea><button type="submit">Send</button></form>
      <div class="btnrow"><button id="next">Next &#8594;</button><button class="ghost" id="report">Report</button><button class="ghost" id="leave">Leave</button></div></div>`);

    const thread = el("thread");
    let sysNote = "";
    const draw = (items) => {
      thread.innerHTML = '<div class="msg sys">You are connected. Say hello!</div>'
        + items.map((m) => m.senderId === user.uid
          ? `<div class="msg mine">${esc(m.body)}</div>`
          : `<div class="msg stranger"><b>Stranger:</b> ${esc(m.body)}</div>`).join("")
        + sysNote;
      thread.scrollTop = thread.scrollHeight;
    };
    let items = [];
    unsubMsgs = onSnapshot(query(collection(db, "rooms", room.id, "messages"), orderBy("createdAt", "desc"), limit(200)), (snap) => {
      items = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" })).reverse();
      draw(items);
    }, () => flash("Could not load messages."));
    unsubRoom = onSnapshot(doc(db, "rooms", room.id), (snap) => {
      if (snap.exists() && snap.data().ended && !room.ended) {
        room.ended = true;
        sysNote = '<div class="msg sys">The stranger has left the chat.</div>';
        el("send").querySelector("textarea").disabled = true;
        el("send").querySelector("button").disabled = true;
        draw(items);
      }
    });

    el("send").onsubmit = async (e) => {
      e.preventDefault();
      const ta = e.target.body, body = ta.value.trim();
      if (!body || room.ended) return;
      ta.value = "";
      try {
        await addDoc(collection(db, "rooms", room.id, "messages"), { senderId: user.uid, body, createdAt: serverTimestamp() });
      } catch (_) { ta.value = body; flash("Message not sent."); }
    };
    el("next").onclick = async () => { await leaveRoom(); room = null; startSearch(); };
    el("leave").onclick = async () => { await leaveRoom(); room = null; showIdle(); bindIdle(); };
    el("report").onclick = async () => {
      const reason = (prompt("What went wrong? (sent to moderators with this chat)") || "").trim();
      if (!reason) return;
      try {
        await addDoc(collection(db, "reports"), {
          reporterId: user.uid, reportedId: room.other,
          reason: `[Blind chat ${room.id}] ${reason}`.slice(0, 500), resolved: false, createdAt: serverTimestamp(),
        });
        flash("Thanks, moderators will review this chat. Tap Next to move on.", "ok");
      } catch (err) { flash(friendly(err)); }
    };
  };

  // ---------- matching
  const enterRoom = async (roomId) => {
    if (room || entering) return;
    entering = true;
    await stopSearch();                                   // also removes my queue entry
    const rs = await getDoc(doc(db, "rooms", roomId));
    if (!rs.exists()) { entering = false; return startSearch(); }
    room = { id: roomId, other: rs.data().participants.find((u) => u !== user.uid), ended: !!rs.data().ended };
    entering = false;
    showRoom();
  };

  const setStat = (t) => { const x = el("sstat"); if (x) x.textContent = t; };
  const tryMatch = async () => {
    if (matching || !searching || room) return;
    matching = true;
    try {
      // Two equality filters only: no composite index needed. Freshness is checked here, against MY
      // server-stamped ping when I have it, so a wrong phone clock can't hide people.
      const snap = await getDocs(query(collection(db, "waiting"),
        where("gender", "==", oppositeOf(self.gender)), where("status", "==", "waiting"), limit(50)));
      const ref = myPing || Date.now();
      const fresh = [];
      snap.docs.forEach((d) => {
        const t = d.data().pingAt && d.data().pingAt.toMillis ? d.data().pingAt.toMillis() : 0;
        if (!t) return;
        if (t >= ref - WAIT_FRESH_MS) fresh.push(d.id);
        else if (t < ref - 180000) deleteDoc(d.ref).catch(() => {});   // tidy abandoned entries
      });
      const cands = shuffle(fresh.filter((id) => id !== user.uid && !blocked.has(id)));
      const hhmm = new Date().toLocaleTimeString();
      setStat(cands.length
        ? `${cands.length} waiting, connecting… (${hhmm})`
        : `Connected. Opposite-gender entries seen: ${snap.size}, active now: ${fresh.length} (checked ${hhmm}). Ask your partner to open Random too.`);
      for (const other of cands) {
        if (!searching) return;
        const theirs = doc(db, "waiting", other), roomRef = doc(collection(db, "rooms"));
        const won = await runTransaction(db, async (tx) => {
          const mine = await tx.get(myWait);
          if (!mine.exists() || mine.data().status !== "waiting") return false;   // someone already matched me
          const t = await tx.get(theirs);
          if (!t.exists() || t.data().status !== "waiting") return false;
          tx.set(roomRef, { participants: [user.uid, other], createdAt: serverTimestamp(), ended: false });
          tx.update(myWait, { status: "matched", roomId: roomRef.id });
          tx.update(theirs, { status: "matched", roomId: roomRef.id });
          return true;
        }).catch((e) => {
          console.error(e);
          const c = e && e.code ? e.code : "";
          setStat(c === "permission-denied"
            ? "Found someone but the security rules refused the match. Publish the latest firestore.rules (all of it) and try again."
            : `Match attempt failed: ${c || e.message}`);
          return false;
        });
        if (won) return;                                  // my queue listener enters the room
      }
    } catch (err) {
      console.error(err);
      const c = err && err.code ? err.code : "";
      setStat(c === "failed-precondition"
        ? "Setup needed: the matching index isn't ready. Run `firebase deploy --only firestore` and wait 2-3 minutes (Firebase console > Firestore > Indexes must say Enabled)."
        : c === "permission-denied"
        ? "Setup needed: the new security rules aren't published. Run `firebase deploy --only firestore`."
        : `Matching error: ${c || err.message}`);
    }
    finally { matching = false; }
  };

  async function startSearch() {
    showSearching();
    searching = true;
    try {
      try {
        const b = await getDocs(query(collection(db, "blocks"), where("blockerId", "==", user.uid)));
        blocked = new Set(b.docs.map((d) => d.data().blockedId));
      } catch (_) {}
      try { await deleteDoc(myWait); } catch (_) {}      // clear any stale entry
      await setDoc(myWait, { gender: self.gender, status: "waiting", roomId: null, pingAt: serverTimestamp() });
      if (!searching) return;                             // cancelled while writing
      unsubWait = onSnapshot(myWait, (snap) => {
        const d = snap.data();
        if (d && d.pingAt && d.pingAt.toMillis) myPing = d.pingAt.toMillis();
        if (d && d.status === "matched" && d.roomId) enterRoom(d.roomId);
        else if (d && myPing && searching) tryMatch();
      }, (err) => {
        console.error(err);
        setStat(err && err.code === "permission-denied"
          ? "Setup needed: the queue rules aren't published. Run `firebase deploy --only firestore` (or paste firestore.rules in the console and Publish)."
          : `Queue error: ${(err && err.code) || err.message}`);
      });
      myPing = 0;
      pingT = setInterval(() => { updateDoc(myWait, { pingAt: serverTimestamp() }).catch(() => {}); }, WAIT_PING_MS);
      tryT = setInterval(tryMatch, WAIT_TRY_MS);
    } catch (err) {
      searching = false;
      showIdle(err && err.code === "permission-denied"
        ? "Setup needed: the new security rules aren't published yet. Run `firebase deploy --only firestore`."
        : friendly(err));
      bindIdle();
    }
  }

  showIdle(); bindIdle();
}


// ------------------------------------------------------------------ guest entry (no registration)
async function pageGuest() {
  if (user && !user.isAnonymous) return go("#/online");
  if (user && user.isAnonymous && guest) return go("#/online");
  const maxDate = new Date().toISOString().slice(0, 10);
  render(`<div class="card narrow small"><h2>Chat as a guest</h2>
    <p class="muted">No email needed. Guests can see who is online, use blind chat and send message requests. To swipe, match and send pictures,
    <a href="#/register">create a free account</a>.</p>
    <form id="f">
      <label>Nickname</label><input name="nickname" required minlength="2" maxlength="20">
      <label>I am</label><select name="gender" required><option value="">Choose…</option><option value="male">Male</option><option value="female">Female</option></select>
      <label>Date of birth</label><input type="date" name="dob" required max="${maxDate}">
      <label class="check"><input type="checkbox" name="adult" value="1"><span>I confirm that I am 18 years of age or older.</span></label>
      <label class="check"><input type="checkbox" name="terms" value="1"><span>I accept the <a href="#/terms" target="_blank">Terms</a>, including that messages may be reviewed by moderators.</span></label>
      <button type="submit" id="submit">Continue</button>
    </form></div>`);
  el("f").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target).entries());
    const nickname = (v.nickname || "").trim();
    const dob = new Date(`${v.dob}T00:00:00Z`);
    const errors = [];
    if (nickname.length < 2 || nickname.length > 20) errors.push("Nickname must be 2-20 characters.");
    if (isNaN(dob) || ageOf(dob) < 18) errors.push("You must be at least 18 years old.");
    if (!["male", "female"].includes(v.gender)) errors.push("Please choose your gender.");
    if (!v.adult) errors.push("You must confirm you are 18 or older.");
    if (!v.terms) errors.push("You must accept the Terms.");
    if (errors.length) return flash(errors.join(" "));

    const btn = el("submit"); btn.disabled = true; busy = true;
    try {
      const u = auth.currentUser && auth.currentUser.isAnonymous ? auth.currentUser : (await signInAnonymously(auth)).user;
      try {
        const gb = writeBatch(db);
        gb.set(doc(db, "guests", u.uid), {
          nickname, gender: v.gender, dob: Timestamp.fromDate(dob), adultConfirmed: true,
          consentAt: serverTimestamp(), createdAt: serverTimestamp(), banned: false,
        });
        gb.set(doc(db, "guestNames", u.uid), { nickname });
        await gb.commit();
      } catch (err) { await u.delete(); throw err; }
      await loadSession(u);
      busy = false;
      go("#/online");
    } catch (err) {
      busy = false; btn.disabled = false;
      flash(friendly(err));
    }
  };
}


// ------------------------------------------------------------------ admin (Firestore rules enforce everything here)
const adminTabs = `<p><a href="#/admin">Members</a> · <a href="#/admin/conversations">Conversations</a> ·
  <a href="#/admin/rooms">Blind chats</a> · <a href="#/admin/reports">Reports</a> · <a href="#/admin/audit">Audit log</a></p>`;

const auditEntry = (action, target, reason) => ({
  adminUid: user.uid, adminEmail: user.email, action, target, reason, createdAt: serverTimestamp(),
});

async function pageAdmin(sub) {
  if (!requireVerified()) return;
  if (!claims.admin) return render('<div class="card"><h2>Forbidden</h2><p>Admins only.</p></div>');

  if (sub === "conversations") {
    const snap = await getDocs(query(collection(db, "conversations"), orderBy("updatedAt", "desc"), limit(200)));
    const rows = [];
    for (const d of snap.docs) {
      const names = await Promise.all(d.data().participants.map(nameOf));
      rows.push({ id: d.id, names, at: d.data().updatedAt?.toMillis?.() });
    }
    return render(`<h2>Conversations</h2>${adminTabs}
      <p class="muted">Opening a conversation requires a written reason and is recorded in the audit log. Review only to handle reports or enforce the Terms.</p>
      <div class="card" style="overflow-x:auto"><table><tr><th>Between</th><th>Last activity</th><th></th></tr>
      ${rows.map((c) => `<tr><td>${esc(c.names.join(" & "))}</td><td>${esc(fmt(c.at))}</td>
        <td><a href="#/admin/thread/${esc(c.id)}">Open</a></td></tr>`).join("") || '<tr><td colspan="3" class="muted">No conversations yet.</td></tr>'}
      </table></div>`);
  }

  if (sub === "thread") {
    const convId = location.hash.split("/")[3] || "";
    const [a, b] = convId.split("_");
    if (!a || !b) return go("#/admin/conversations");
    const reason = prompt("Reason for viewing this conversation (recorded in the audit log):");
    if (!reason || reason.trim().length < 5) {
      flash("A reason of at least 5 characters is required to open a conversation.");
      return go("#/admin/conversations");
    }
    // 1) audit entry + 10-minute access grant in ONE batch (rules reject a grant without a fresh audit entry)
    const auditRef = doc(collection(db, "auditLog"));
    const batch = writeBatch(db);
    batch.set(auditRef, auditEntry("view_conversation", convId, reason.trim().slice(0, 300)));
    batch.set(doc(db, "accessGrants", `${user.uid}_${convId}`), {
      adminUid: user.uid, convId, auditId: auditRef.id, viewedAt: serverTimestamp(),
    });
    await batch.commit();
    // 2) now the messages become readable
    const [msgs, nameA, nameB, emailA, emailB] = await Promise.all([
      getDocs(query(collection(db, "conversations", convId, "messages"), orderBy("createdAt"), limit(1000))),
      nameOf(a), nameOf(b),
      getDoc(doc(db, "userPrivate", a)), getDoc(doc(db, "userPrivate", b)),
    ]);
    const names = { [a]: nameA, [b]: nameB };
    return render(`<p><a href="#/admin/conversations">&larr; All conversations</a></p>
      <div class="card"><h3>${esc(nameA)} (${esc(emailA.data()?.email || "")}) &amp; ${esc(nameB)} (${esc(emailB.data()?.email || "")})</h3>
      <div class="thread">${msgs.docs.map((d) => { const m = d.data(); return `<div class="msg ${m.senderId === a ? "mine" : ""}">
        <b>${esc(names[m.senderId] || "?")}:</b> ${esc(m.body)}<small>${esc(fmt(m.createdAt?.toMillis?.()))}</small></div>`; }).join("")
        || '<p class="muted">No messages.</p>'}</div></div>`);
  }

  if (sub === "rooms") {
    const snap = await getDocs(query(collection(db, "rooms"), orderBy("createdAt", "desc"), limit(200)));
    const rows = [];
    for (const d of snap.docs) {
      const names = await Promise.all(d.data().participants.map(nameOf));
      rows.push({ id: d.id, names, at: d.data().createdAt?.toMillis?.() });
    }
    return render(`<h2>Blind chats</h2>${adminTabs}
      <p class="muted">Opening a chat requires a written reason and is recorded in the audit log. Reports on blind chats include the room id.</p>
      <div class="card" style="overflow-x:auto"><table><tr><th>Between</th><th>Started</th><th>Room</th><th></th></tr>
      ${rows.map((c) => `<tr><td>${esc(c.names.join(" & "))}</td><td>${esc(fmt(c.at))}</td><td class="muted">${esc(c.id)}</td>
        <td><a href="#/admin/room/${esc(c.id)}">Open</a></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No blind chats yet.</td></tr>'}
      </table></div>`);
  }

  if (sub === "room") {
    const roomId = location.hash.split("/")[3] || "";
    if (!roomId) return go("#/admin/rooms");
    const reason = prompt("Reason for viewing this blind chat (recorded in the audit log):");
    if (!reason || reason.trim().length < 5) {
      flash("A reason of at least 5 characters is required to open a chat.");
      return go("#/admin/rooms");
    }
    const auditRef = doc(collection(db, "auditLog"));
    const batch = writeBatch(db);
    batch.set(auditRef, auditEntry("view_conversation", roomId, reason.trim().slice(0, 300)));
    batch.set(doc(db, "accessGrants", `${user.uid}_${roomId}`), {
      adminUid: user.uid, convId: roomId, auditId: auditRef.id, viewedAt: serverTimestamp(),
    });
    await batch.commit();
    const [rs, msgs] = await Promise.all([
      getDoc(doc(db, "rooms", roomId)),
      getDocs(query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt"), limit(1000))),
    ]);
    if (!rs.exists()) return go("#/admin/rooms");
    const [a, b] = rs.data().participants;
    const [nameA, nameB, emailA, emailB] = await Promise.all([nameOf(a), nameOf(b), getDoc(doc(db, "userPrivate", a)), getDoc(doc(db, "userPrivate", b))]);
    const names = { [a]: nameA, [b]: nameB };
    return render(`<p><a href="#/admin/rooms">&larr; All blind chats</a></p>
      <div class="card"><h3>${esc(nameA)} (${esc(emailA.data()?.email || "")}) &amp; ${esc(nameB)} (${esc(emailB.data()?.email || "")})</h3>
      <div class="thread">${msgs.docs.map((d) => { const m = d.data(); return `<div class="msg ${m.senderId === a ? "mine" : ""}">
        <b>${esc(names[m.senderId] || "?")}:</b> ${esc(m.body)}<small>${esc(fmt(m.createdAt?.toMillis?.()))}</small></div>`; }).join("")
        || '<p class="muted">No messages.</p>'}</div></div>`);
  }

  if (sub === "reports") {
    const snap = await getDocs(query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(200)));
    const rows = [];
    for (const d of snap.docs) {
      const r = d.data();
      rows.push({ id: d.id, ...r, reporter: await nameOf(r.reporterId), reported: await nameOf(r.reportedId), at: r.createdAt?.toMillis?.() });
    }
    render(`<h2>Reports</h2>${adminTabs}<div class="card" style="overflow-x:auto"><table>
      <tr><th>When</th><th>Reporter</th><th>Reported</th><th>Reason</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(fmt(r.at))}</td><td>${esc(r.reporter)}</td><td>${esc(r.reported)}</td><td>${esc(r.reason)}</td>
        <td>${r.resolved ? '<span class="badge ok">resolved</span>' : `<button class="link" data-resolve="${esc(r.id)}">Mark resolved</button>`}</td></tr>`).join("")
        || '<tr><td colspan="5" class="muted">No reports.</td></tr>'}</table></div>`);
    document.querySelectorAll("[data-resolve]").forEach((b) => {
      b.onclick = async () => {
        try {
          const batch = writeBatch(db);
          batch.update(doc(db, "reports", b.dataset.resolve), { resolved: true });
          batch.set(doc(collection(db, "auditLog")), auditEntry("resolve_report", b.dataset.resolve, "Report resolved in admin panel"));
          await batch.commit();
          route();
        } catch (err) { flash(friendly(err)); }
      };
    });
    return;
  }

  if (sub === "audit") {
    const snap = await getDocs(query(collection(db, "auditLog"), orderBy("createdAt", "desc"), limit(300)));
    return render(`<h2>Audit log</h2>${adminTabs}<div class="card" style="overflow-x:auto"><table>
      <tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th></tr>
      ${snap.docs.map((d) => { const e = d.data(); return `<tr><td>${esc(fmt(e.createdAt?.toMillis?.()))}</td><td>${esc(e.adminEmail)}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td>${esc(e.reason)}</td></tr>`; }).join("")
        || '<tr><td colspan="5" class="muted">Nothing logged yet.</td></tr>'}</table></div>`);
  }

  // Members overview
  const [gsnap, users, priv, cUsers, cReports] = await Promise.all([
    getDocs(query(collection(db, "guests"), limit(300))),
    getDocs(query(collection(db, "users"), where("hidden", "==", false), limit(300))),
    getDocs(query(collection(db, "userPrivate"), limit(500))),
    getCountFromServer(query(collection(db, "users"), where("hidden", "==", false))),
    getCountFromServer(query(collection(db, "reports"), where("resolved", "==", false))),
  ]);
  const emails = Object.fromEntries(priv.docs.map((d) => [d.id, d.data().email]));
  const rows = users.docs.map((d) => ({ uid: d.id, ...d.data() }))
    .sort((x, y) => (y.createdAt?.toMillis?.() || 0) - (x.createdAt?.toMillis?.() || 0));
  render(`<h2>Admin</h2>${adminTabs}
    <div class="stats">
      <div class="stat"><b>${cUsers.data().count}</b>Members</div>
      <div class="stat"><b>${cReports.data().count}</b>Open reports</div></div>
    <div class="card" style="overflow-x:auto"><table>
      <tr><th>Name</th><th>Email</th><th>City</th><th>Status</th><th></th></tr>
      ${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(emails[u.uid] || "")}</td><td>${esc(u.city)}</td>
        <td>${u.banned ? '<span class="badge err">banned</span>' : '<span class="badge ok">active</span>'}</td>
        <td><button class="link" data-ban="${esc(u.uid)}" data-state="${u.banned ? "1" : "0"}">${u.banned ? "Unban" : "Ban"}</button></td></tr>`).join("")}
    </table></div>
    <h3>Guests</h3><div class="card" style="overflow-x:auto"><table>
      <tr><th>Nickname</th><th>Joined</th><th>Status</th><th></th></tr>
      ${gsnap.docs.map((d) => { const g = d.data(); return `<tr><td>${esc(g.nickname)}</td><td>${esc(fmt(g.createdAt?.toMillis?.()))}</td>
        <td>${g.banned ? '<span class="badge err">banned</span>' : '<span class="badge ok">active</span>'}</td>
        <td><button class="link" data-gban="${esc(d.id)}" data-state="${g.banned ? "1" : "0"}">${g.banned ? "Unban" : "Ban"}</button></td></tr>`; }).join("")
        || '<tr><td colspan="4" class="muted">No guests yet.</td></tr>'}
    </table></div>`);
  document.querySelectorAll("[data-ban]").forEach((b) => {
    b.onclick = async () => {
      const ban = b.dataset.state !== "1";
      if (ban && !confirm("Ban this member? They will be signed out and unable to chat.")) return;
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, "users", b.dataset.ban), { banned: ban });
        batch.set(doc(collection(db, "auditLog")), auditEntry(ban ? "ban" : "unban", b.dataset.ban, `${ban ? "Ban" : "Unban"} from admin panel`));
        await batch.commit();
        route();
      } catch (err) { flash(friendly(err)); }
    };
  });

  document.querySelectorAll("[data-gban]").forEach((b) => {
    b.onclick = async () => {
      const ban = b.dataset.state !== "1";
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, "guests", b.dataset.gban), { banned: ban });
        batch.set(doc(collection(db, "auditLog")), auditEntry(ban ? "ban_guest" : "unban_guest", b.dataset.gban, `${ban ? "Ban" : "Unban"} guest from admin panel`));
        await batch.commit();
        route();
      } catch (err) { flash(friendly(err)); }
    };
  });
}

