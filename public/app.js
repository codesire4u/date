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

// ---- presence: a member counts as "online" if their lastSeen heartbeat is under 6 minutes old
const ONLINE_MS = 6 * 60 * 1000, BEAT_MS = 4 * 60 * 1000;
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
      <p>Guests can use the lobby, the online list, blind chat and messages. Discover (browsing all profiles) is for members: create a free account to unlock it.</p>
      <p><a class="btn" href="#/register">Sign up</a> <a class="btn ghost" href="#/lobby">Back to lobby</a></p></div>`);
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

function renderNav() {
  el("nav").innerHTML = user && user.isAnonymous
    ? `<a href="#/random">Random</a><a href="#/online">Online</a><a href="#/lobby">Lobby</a><a href="#/chat">Messages</a><a class="btn" href="#/register">Sign up</a><button class="ghost" id="logout">Leave</button>`
    : user
    ? `<a href="#/browse">Discover</a><a href="#/random">Random</a><a href="#/online">Online</a><a href="#/lobby">Lobby</a><a href="#/chat">Messages</a>${claims.admin ? '<a href="#/admin">Admin</a>' : ""}<button class="ghost" id="logout">Log out</button>`
    : `<a href="#/login">Log in</a><a class="btn" href="#/register">Join</a>`;
  const lo = el("logout");
  if (lo) lo.onclick = async () => { await signOut(auth); go("#/"); };
}

// ------------------------------------------------------------------ router
async function route() {
  cleanup();
  flash("");
  if (pendingFlash) { flash(pendingFlash, "warn"); pendingFlash = null; }
  renderNav();
  if (user && !user.isAnonymous && profile && !presenceTimer) startPresence();
  const [, page = "", arg = ""] = (location.hash || "#/").split("/");
  try {
    switch (page) {
      case "": return pageHome();
      case "terms": return pageTerms();
      case "register": return pageRegister();
      case "login": return pageLogin();
      case "verify": return pageVerify();
      case "guest": return await pageGuest();
      case "lobby": return await pageLobby();
      case "browse": return await pageBrowse();
      case "online": return await pageOnline();
      case "random": return await pageRandom();
      case "profile": return await pageProfile(arg);
      case "chat": return arg ? await pageChat(arg) : await pageInbox();
      case "admin": return await pageAdmin(arg);
      default: return render('<div class="card"><h2>Page not found</h2></div>');
    }
  } catch (err) {
    console.error(err);
    flash(friendly(err));
  }
}

window.addEventListener("hashchange", route);
onAuthStateChanged(auth, async (u) => {
  await loadSession(u);
  startPresence();
  if (!busy) route();
});

// ------------------------------------------------------------------ public pages
function pageHome() {
  render(`
    <div class="hero">
      <h1>Where <em>desire</em> meets connection.</h1>
      <p class="muted">Flirt, tease and fall for someone new. An 18+ community for adults who want chemistry, passion and a little mischief. Verified emails, blocking and reporting keep it safe.</p>
      <p style="margin-top:24px"><a class="btn" href="#/${user && !user.isAnonymous ? "browse" : "register"}">${user && !user.isAnonymous ? "Discover people" : "Find your spark"}</a>
        <a class="btn ghost" href="#/${user ? "lobby" : "guest"}">${user ? "Open lobby" : "Chat as guest (no sign-up)"}</a>
        ${user && !user.isAnonymous ? '<a class="btn ghost" href="#/random">&#127917; Blind chat</a>' : ""}</p>
    </div>
    <div class="grid">
      <div class="card"><h3>&#128149; Adults only</h3><p class="muted">Everyone confirms they are an adult and enters their date of birth at sign-up.</p></div>
      <div class="card"><h3>&#128140; Real people</h3><p class="muted">Chat unlocks only after you confirm your email address.</p></div>
      <div class="card"><h3>&#127801; You set the pace</h3><p class="muted">Block or report anyone at any time. Moderators act on reports.</p></div>
    </div>`);
}

function pageTerms() {
  render(`<div class="card"><h2>Terms &amp; Privacy (summary)</h2><ul>
    <li>You must be 18 or older. Accounts found to belong to minors are removed.</li>
    <li>Everything must be consensual. Harassment, pressure, threats, or sharing someone's content without permission lead to a ban.</li>
    <li>No payment solicitation, scams, escorting or commercial sex offers, and no illegal content.</li>
    <li><b>Message moderation:</b> private messages are not end-to-end encrypted. Authorised moderators may review a conversation to investigate reports, enforce these rules and keep members safe. Each access requires a written reason and is recorded in an audit log.</li>
    <li><b>Guest chat:</b> guests may use the public lobby, the online list, blind chat and private messages (not Discover), must confirm they are 18+, and are bound by the same rules and moderation. Lobby messages are visible to all guests and members.</li>
    <li>We store your email, profile details and messages to run the service. Your email is never shown to other members.</li>
    <li><b>Blind chat:</b> random chat pairs you with an anonymous member of the opposite gender. Names are hidden in the chat, but these conversations are stored and may be reviewed by moderators like any other message. Harassment or pressure ends with a ban.</li>
    <li><b>Online status:</b> other members can see that you are online, and your city, while you have the site open. Turn this off any time with \"Show me as online\" on the Online page.</li>
    <li><b>Location (optional):</b> if you tap \"Use my location\", we save only a rough area about 5 km wide. Other members see a distance range such as \"Within 10 km\", never your exact position. You can stop sharing at any time from the Discover page.</li>
    <li>Meet in public first, tell a friend where you are going, and practise safer sex.</li></ul>
    <p class="muted">Replace this summary with a full policy reviewed by a lawyer before launch.</p></div>`);
}

// ------------------------------------------------------------------ auth pages
function pageRegister() {
  if (user && !user.isAnonymous) return go("#/browse");
  const maxDate = new Date().toISOString().slice(0, 10);
  render(`
  <div class="card narrow"><h2>Find your spark</h2>
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
  render(`<div class="card narrow small"><h2>Log in</h2><form id="f">
    <label>Email</label><input type="email" name="email" required>
    <label>Password</label><input type="password" name="password" required>
    <p><button type="submit">Log in</button></p>
    <p class="muted">New here? <a href="#/register">Create an account</a></p></form></div>`);
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
    go("#/browse");
  } else if (!silent) {
    flash("Not verified yet. Click the link in the email we sent, then try again.", "warn");
  }
}

function pageVerify() {
  if (!requireLogin()) return;
  if (user.isAnonymous) return go("#/lobby");
  if (user.emailVerified) return go("#/browse");
  render(`<div class="card narrow"><h2>Check your email</h2>
    <p>We sent a confirmation link to <b>${esc(user.email)}</b>. Chat unlocks as soon as you click it.
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

// ------------------------------------------------------------------ discover & profiles
async function pageBrowse() {
  if (!requireVerified()) return;
  if (!profile) {
    return render('<div class="card"><p>No member profile found for this account.</p></div>');
  }
  const geo = hasCell(profile);
  let radius = geo ? 25 : 0;   // km; 0 = any distance
  render(`<div class="card" id="nearbox"></div>
    <form id="filter" class="sendbar" style="margin-bottom:16px">
    <input name="city" placeholder="Filter by city"><button type="submit">Search</button></form>
    <div class="grid" id="people"><p class="muted">Loading…</p></div>`);

  el("nearbox").innerHTML = geo
    ? `<h3 style="margin-bottom:8px">&#128205; People near you</h3>
       <div class="sendbar" style="align-items:center;flex-wrap:wrap">
         <label style="margin:0">Show within</label>
         <select id="radius" style="width:auto">
           <option value="10">10 km</option><option value="25" selected>25 km</option>
           <option value="50">50 km</option><option value="100">100 km</option><option value="0">Any distance</option>
         </select>
         <button class="ghost" id="sharebtn" type="button">Update my location</button>
         <button class="ghost" id="stopshare" type="button">Stop sharing</button>
       </div>
       <p class="muted" style="margin:8px 0 0">Others only see a rough distance such as "Within 10 km", never your exact location.</p>`
    : `<h3 style="margin-bottom:6px">&#128205; Find people near you</h3>
       <p class="muted">Share your approximate location to see members close to you and message them. We save only a rough area (about 5 km wide), and others see just a distance range, never where you are exactly. You can stop sharing any time.</p>
       <button id="sharebtn" type="button">Use my location</button>`;

  el("sharebtn").onclick = () => {
    if (!navigator.geolocation) return flash("Your browser cannot share location. You can still filter by city.");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const gx = Math.round(pos.coords.latitude * 20), gy = Math.round(pos.coords.longitude * 20);
        await updateDoc(doc(db, "users", user.uid), { gx, gy });
        profile.gx = gx; profile.gy = gy;
        route();
      } catch (err) { flash(friendly(err)); }
    }, () => flash("Location was blocked or unavailable. Allow location for this site in your browser, or filter by city."),
    { maximumAge: 600000, timeout: 15000 });
  };
  if (geo) {
    el("stopshare").onclick = async () => {
      try {
        await updateDoc(doc(db, "users", user.uid), { gx: deleteField(), gy: deleteField() });
        delete profile.gx; delete profile.gy;
        route();
      } catch (err) { flash(friendly(err)); }
    };
  }

  const [snap, blocks] = await Promise.all([
    getDocs(query(collection(db, "users"),
      where("gender", "==", profile.lookingFor), where("lookingFor", "==", profile.gender),
      where("banned", "==", false), where("hidden", "==", false), limit(geo ? 200 : 60))),
    getDocs(query(collection(db, "blocks"), where("blockerId", "==", user.uid))),
  ]);
  const blocked = new Set(blocks.docs.map((d) => d.data().blockedId));
  const people = snap.docs.filter((d) => d.id !== user.uid && !blocked.has(d.id)).map((d) => ({ id: d.id, ...d.data() }));

  const draw = (cityFilter) => {
    let list = people.filter((p) => !cityFilter || p.city.toLowerCase().includes(cityFilter.toLowerCase()));
    if (geo) {
      list = list.map((p) => ({ ...p, km: hasCell(p) ? distKm(profile, p) : null }));
      if (radius) list = list.filter((p) => p.km !== null && p.km <= radius);
      list.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    }
    el("people").innerHTML = list.map((p) => `
      <div class="card"><h3>${esc(p.name)}, ${ageOf(p.dob.toDate())}</h3>
      <p class="muted">${p.km != null ? "&#128205; " + distLabel(p.km) + " · " : ""}${esc(p.city)}</p>
      <p>${esc(p.bio.slice(0, 140))}${p.bio.length > 140 ? "…" : ""}</p>
      <a class="btn ghost" href="#/profile/${esc(p.id)}">View</a>
      <a class="btn" href="#/chat/${esc(p.id)}">Message</a></div>`).join("")
      || (geo && radius
        ? `<p class="muted">Nobody within ${radius} km has shared their location yet. Try a bigger distance, or check back soon.</p>`
        : '<p class="muted">No members match yet. Check back soon.</p>');
  };
  draw("");
  el("filter").onsubmit = (e) => { e.preventDefault(); draw(e.target.city.value.trim()); };
  if (geo) el("radius").onchange = (e) => { radius = Number(e.target.value); draw(el("filter").city.value.trim()); };
}

async function pageOnline() {
  if (!requireChatter()) return;
  const isGuest = user.isAnonymous;
  const me = isGuest ? {} : profile;
  if (!isGuest && !profile) return render('<div class="card"><p>No member profile found for this account.</p></div>');
  render(`<div class="card"><h3 style="margin-bottom:8px"><span class="dot"></span>Online now</h3>
    <div class="sendbar" style="align-items:center;flex-wrap:wrap">
      <label style="margin:0">Show</label>
      <select id="who" style="width:auto"><option value="">Everyone</option><option value="female">Women</option><option value="male">Men</option></select>
      <button class="ghost" id="refresh" type="button">Refresh</button>
      ${isGuest ? "" : '<label class="check" style="margin:0"><input type="checkbox" id="showme"><span>Show me as online</span></label>'}
    </div>
    <p class="muted" style="margin:8px 0 0">Members from your city come first, then the nearest. Tap Message to text anyone directly.</p></div>
    <div class="grid" id="onlinelist"><p class="muted">Loading…</p></div>`);

  const showme = el("showme");
  if (showme) {
    showme.checked = !presenceHidden();
    showme.onchange = async () => {
      try {
        if (showme.checked) { localStorage.removeItem("desire_hide_online"); await beat(); }
        else { localStorage.setItem("desire_hide_online", "1"); await updateDoc(doc(db, "users", user.uid), { lastSeen: deleteField() }); }
      } catch (err) { flash(friendly(err)); }
    };
  }

  const norm = (x) => String(x || "").trim().toLowerCase();
  const ago = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 5 ? "Online now" : `Active ${m} min ago`; };
  let people = [];

  const draw = () => {
    const who = el("who").value, mine = norm(me.city);
    const list = people.filter((p) => !who || p.gender === who).map((p) => ({
      ...p, same: norm(p.city) === mine, seen: p.lastSeen.toMillis(),
      km: hasCell(profile) && hasCell(p) ? distKm(profile, p) : null,
    }));
    // your city first, then nearest, then most recently active
    list.sort((a, b) => (b.same - a.same) || ((a.km ?? 1e9) - (b.km ?? 1e9)) || (b.seen - a.seen));
    el("onlinelist").innerHTML = list.map((p) => `
      <div class="card"><h3><span class="dot"></span>${esc(p.name)}, ${ageOf(p.dob.toDate())}</h3>
      <p class="muted">${p.same ? '<span class="badge ok">Your city</span> ' : ""}${p.km != null ? "&#128205; " + distLabel(p.km) + " · " : ""}${esc(p.city)}</p>
      <p class="muted">${ago(p.seen)}</p>
      <p>${esc(p.bio.slice(0, 120))}${p.bio.length > 120 ? "…" : ""}</p>
      <a class="btn ghost" href="#/profile/${esc(p.id)}">View</a>
      <a class="btn" href="#/chat/${esc(p.id)}">Message</a></div>`).join("")
      || '<p class="muted">Nobody else is online right now. Check back soon, or browse Discover.</p>';
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

  el("who").onchange = draw;
  el("refresh").onclick = () => load().catch((err) => flash(friendly(err)));
  await load();
  const t = setInterval(() => load().catch(() => {}), 60000);   // auto-refresh while this page is open
  cleanups.push(() => clearInterval(t));
}

async function pageProfile(uid) {
  if (!requireChatter()) return;
  const isGuest = user.isAnonymous;
  const s = await getDoc(doc(db, "users", uid));
  if (!s.exists() || s.data().banned || s.data().hidden) return render('<div class="card">Profile not found.</div>');
  const p = s.data();
  render(`<div class="card"><h2>${esc(p.name)}, ${ageOf(p.dob.toDate())}</h2>
    <p class="muted">${hasCell(profile) && hasCell(p) ? "&#128205; " + distLabel(distKm(profile, p)) + " · " : ""}${esc(p.city)} · ${esc(p.gender)}</p>
    <p style="white-space:pre-wrap">${esc(p.bio || "No bio yet.")}</p>
    <p><a class="btn" href="#/chat/${esc(uid)}">Message</a></p>
    <hr style="border-color:var(--line)">
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      ${isGuest ? "" : '<button class="ghost" id="block">Block</button>'}
      <form id="report" style="display:flex;gap:8px;flex:1;min-width:240px">
        <input name="reason" placeholder="Report a problem…" maxlength="500" required>
        <button class="ghost" type="submit">Report</button></form>
    </div></div>`);
  if (el("block")) el("block").onclick = async () => {
    if (!confirm("Block this member?")) return;
    await setDoc(doc(db, "blocks", `${user.uid}_${uid}`), { blockerId: user.uid, blockedId: uid, createdAt: serverTimestamp() });
    go("#/browse");
  };
  el("report").onsubmit = async (e) => {
    e.preventDefault();
    const reason = e.target.reason.value.trim();
    if (!reason) return;
    try {
      await addDoc(collection(db, "reports"), {
        reporterId: user.uid, reportedId: uid, reason, resolved: false, createdAt: serverTimestamp(),
      });
      e.target.reset();
      flash("Thanks, our moderators will review this report.", "ok");
    } catch (err) { flash(friendly(err)); }
  };
}

// ------------------------------------------------------------------ chat
async function pageInbox() {
  if (!requireChatter()) return;
  render('<h2>Messages</h2><div id="list"><p class="muted">Loading…</p></div>');
  const q = query(collection(db, "conversations"), where("participants", "array-contains", user.uid), limit(100));
  const unsub = onSnapshot(q, async (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
      .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    for (const c of items) {
      c.other = c.participants.find((p) => p !== user.uid);
      c.name = await nameOf(c.other);
    }
    el("list").innerHTML = items.map((c) => `
      <a href="#/chat/${esc(c.other)}" style="color:inherit;text-decoration:none"><div class="card">
      <b>${esc(c.name)}</b> <span class="muted">· last message ${esc(fmt(c.updatedAt?.toMillis?.()))}</span></div></a>`).join("")
      || `<p class="muted">No conversations yet. <a href="${user.isAnonymous ? "#/online" : "#/browse"}">Find someone to talk to.</a></p>`;
  }, (err) => flash(friendly(err)));
  cleanups.push(unsub);
}

async function pageChat(uid) {
  if (!requireChatter()) return;
  if (uid === user.uid) return go("#/chat");
  const ps = await getDoc(doc(db, "users", uid));
  let p, partnerIsGuest = false;
  if (ps.exists()) {
    if (ps.data().banned) return render('<div class="card">This member is not available.</div>');
    p = ps.data();
  } else {
    const gs = await getDoc(doc(db, "guestNames", uid)).catch(() => null);
    if (!gs || !gs.exists()) return render('<div class="card">This member is not available.</div>');
    p = { name: `${gs.data().nickname} (guest)` };
    partnerIsGuest = true;
  }
  const pair = [user.uid, uid].sort();
  const convId = pair.join("_");

  render(`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 style="margin:0">${partnerIsGuest ? esc(p.name) : `<a href="#/profile/${esc(uid)}">${esc(p.name)}</a>`}</h3>
      <span class="muted">Chats may be reviewed by moderators for safety.</span></div>
    <div class="thread" id="thread"></div>
    <form id="send" class="sendbar"><textarea name="body" required maxlength="2000" placeholder="Write a message…"></textarea>
    <button type="submit">Send</button></form>
    ${partnerIsGuest || user.isAnonymous ? `<div class="btnrow">${!user.isAnonymous ? '<button class="ghost" id="gblock">Block</button>' : ""}<button class="ghost" id="greport">Report</button></div>` : ""}</div>`);

  if (el("gblock")) el("gblock").onclick = async () => {
    if (!confirm("Block this person?")) return;
    try {
      await setDoc(doc(db, "blocks", `${user.uid}_${uid}`), { blockerId: user.uid, blockedId: uid, createdAt: serverTimestamp() });
      go("#/chat");
    } catch (err) { flash(friendly(err)); }
  };
  if (el("greport")) el("greport").onclick = async () => {
    const reason = (prompt("What went wrong? (sent to moderators)") || "").trim();
    if (!reason) return;
    try {
      await addDoc(collection(db, "reports"), {
        reporterId: user.uid, reportedId: uid, reason: `[Private chat ${convId}] ${reason}`.slice(0, 500), resolved: false, createdAt: serverTimestamp(),
      });
      flash("Thanks, moderators will review this report.", "ok");
    } catch (err) { flash(friendly(err)); }
  };

  const thread = el("thread");
  const q = query(collection(db, "conversations", convId, "messages"), orderBy("createdAt", "desc"), limit(200));
  const unsub = onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" })).reverse();
    thread.innerHTML = items.map((m) => `<div class="msg ${m.senderId === user.uid ? "mine" : ""}">${esc(m.body)}<small>${esc(m.createdAt ? m.createdAt.toDate().toLocaleString() : "")}</small></div>`).join("");
    thread.scrollTop = thread.scrollHeight;
  }, () => flash("Could not load messages."));
  cleanups.push(unsub);

  el("send").onsubmit = async (e) => {
    e.preventDefault();
    const ta = e.target.body;
    const body = ta.value.trim();
    if (!body) return;
    ta.value = "";
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "conversations", convId), { participants: pair, updatedAt: serverTimestamp() });
      batch.set(doc(collection(db, "conversations", convId, "messages")), {
        senderId: user.uid, body, createdAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      ta.value = body;
      flash("Message not sent. You may be blocked, or this member is unavailable.");
    }
  };
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
    <div class="notice">Be respectful. Never share contact details or money. Chats are stored and may be reviewed by moderators; use <b>Report</b> if someone crosses a line.</div>
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
        <span class="muted">Anonymous. Chats may be reviewed by moderators.</span></div>
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

// ------------------------------------------------------------------ guest lobby (no registration)
async function pageGuest() {
  if (user && !user.isAnonymous) return go("#/lobby");
  if (user && user.isAnonymous && guest) return go("#/lobby");
  const maxDate = new Date().toISOString().slice(0, 10);
  render(`<div class="card narrow small"><h2>Chat as a guest</h2>
    <p class="muted">No email needed. Guests can use the lobby, online list, blind chat and messages. To browse everyone in Discover,
    <a href="#/register">create a free account</a>.</p>
    <form id="f">
      <label>Nickname</label><input name="nickname" required minlength="2" maxlength="20">
      <label>I am</label><select name="gender" required><option value="">Choose…</option><option value="male">Male</option><option value="female">Female</option></select>
      <label>Date of birth</label><input type="date" name="dob" required max="${maxDate}">
      <label class="check"><input type="checkbox" name="adult" value="1"><span>I confirm that I am 18 years of age or older.</span></label>
      <label class="check"><input type="checkbox" name="terms" value="1"><span>I accept the <a href="#/terms" target="_blank">Terms</a>, including that messages may be reviewed by moderators.</span></label>
      <button type="submit" id="submit">Enter lobby</button>
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
      go("#/lobby");
    } catch (err) {
      busy = false; btn.disabled = false;
      flash(friendly(err));
    }
  };
}

async function pageLobby() {
  if (!user) return go("#/guest");
  if (user.isAnonymous && !guest) return go("#/guest");
  if (!user.isAnonymous && !user.emailVerified) return go("#/verify");
  const canPost = user.isAnonymous ? !!guest : !!profile;
  render(`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
      <h3 style="margin:0">Public lobby</h3>
      <span class="muted">Open to guests and members. Moderated; messages may be reviewed. Never share personal contact details.</span></div>
    <div class="thread" id="thread"></div>
    ${canPost ? `<form id="send" class="sendbar"><textarea name="body" required maxlength="500" placeholder="Write a message…"></textarea>
      <button type="submit">Send</button></form>` : '<p class="muted">Read-only.</p>'}</div>`);

  const thread = el("thread");
  let current = [];
  const q = query(collection(db, "lobby"), orderBy("createdAt", "desc"), limit(100));
  const unsub = onSnapshot(q, (snap) => {
    current = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).reverse();
    thread.innerHTML = current.map((m) => `<div class="msg ${m.senderId === user.uid ? "mine" : ""}">
      <b>${esc(m.name)}:</b> ${esc(m.body)}<small>${esc(fmt(m.createdAt?.toMillis?.()))}
      ${m.senderId !== user.uid ? ` · <button class="link" data-report="${esc(m.id)}">report</button>` : ""}
      ${claims.admin ? ` · <button class="link" data-del="${esc(m.id)}">delete</button>` : ""}</small></div>`).join("")
      || '<p class="muted">No messages yet. Say hello.</p>';
    thread.scrollTop = thread.scrollHeight;
  }, () => flash("Could not load the lobby."));
  cleanups.push(unsub);

  thread.onclick = async (e) => {
    const t = e.target;
    try {
      if (t.dataset.report) {
        const m = current.find((x) => x.id === t.dataset.report);
        if (!m || !confirm("Report this message to moderators?")) return;
        await addDoc(collection(db, "reports"), {
          reporterId: user.uid, reportedId: m.senderId,
          reason: `Lobby message by ${m.name}: ${m.body}`.slice(0, 500), resolved: false, createdAt: serverTimestamp(),
        });
        flash("Thanks, our moderators will review this report.", "ok");
      } else if (t.dataset.del && claims.admin) {
        const batch = writeBatch(db);
        batch.delete(doc(db, "lobby", t.dataset.del));
        batch.set(doc(collection(db, "auditLog")), auditEntry("delete_message", t.dataset.del, "Lobby message removed by moderator"));
        await batch.commit();
      }
    } catch (err) { flash(friendly(err)); }
  };

  if (canPost) {
    el("send").onsubmit = async (e) => {
      e.preventDefault();
      const ta = e.target.body;
      const body = ta.value.trim();
      if (!body) return;
      ta.value = "";
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "lobbyState", user.uid), { lastPostAt: serverTimestamp() });
        batch.set(doc(collection(db, "lobby")), {
          senderId: user.uid, name: user.isAnonymous ? guest.nickname : profile.name, body, createdAt: serverTimestamp(),
        });
        await batch.commit();
      } catch (err) {
        ta.value = body;
        flash("Message not sent. Please wait a few seconds between messages.");
      }
    };
  }
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
