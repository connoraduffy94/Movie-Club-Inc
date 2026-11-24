import { createStore } from "./store.js";

const $ = (sel) => document.querySelector(sel);
const NAME_KEY = "movieclub-name";

let store;
let movies = [];
let night = null;
let countdownTimer = null;
let showAll = false;

const TOP_N = 10;                 // films shown before "Show all"
const DUSTY_AFTER = 60 * 864e5;   // no votes for ~2 months → "Gathering dust"

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const getName = () => { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } };
const setName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function fail(err) {
  console.error(err);
  toast(err?.code === "permission-denied" ? "Not allowed. Check the Firestore rules." : "Something went wrong. Please try again.", true);
}

const pending = () => movies.filter((m) => m.status !== "watched")
  .sort((a, b) => (b.votes?.length || 0) - (a.votes?.length || 0) || a.createdAt - b.createdAt);
// Films on the shortlist that belong to me: added from this browser, or under my name (e.g. from my other device).
const myPicks = () => {
  const name = getName().trim().toLowerCase();
  return pending().filter((m) => m.submittedByUid === store?.uid
    || (name && (m.submittedBy || "").trim().toLowerCase() === name));
};

// A film is dusty if nobody has voted for it and it was added (or votes were last reset) over 2 months ago.
const isDusty = (m) => !(m.votes?.length) && Date.now() - Math.max(m.createdAt || 0, m.roundStartedAt || 0) > DUSTY_AFTER;

function ago(t) {
  if (!t) return "";
  const days = Math.floor((Date.now() - t) / 864e5);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

const watched = () => movies.filter((m) => m.status === "watched")
  .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));

/* ---------- who am I ---------- */
function renderWhoami() {
  const el = $("#whoami");
  const name = getName();
  if (name) {
    el.innerHTML = `<span class="muted">Hi,</span> <strong>${esc(name)}</strong> <button class="linkish" id="change-name">change</button>`;
    $("#change-name").onclick = () => { setName(""); renderWhoami(); renderSubmit(); };
  } else {
    el.innerHTML = `<form id="name-form" class="whoami"><input name="n" maxlength="40" placeholder="Your name" required aria-label="Your name"><button class="btn small primary">Save</button></form>`;
    $("#name-form").onsubmit = (e) => {
      e.preventDefault();
      const n = e.target.n.value.trim();
      if (n) { setName(n); renderWhoami(); renderSubmit(); toast(`Welcome, ${n}!`); }
    };
  }
}

function requireName() {
  if (getName()) return true;
  toast("Add your name at the top first", true);
  document.querySelector("#name-form input")?.focus();
  return false;
}

/* ---------- next movie night ---------- */
function gcalLink(n, title) {
  const start = new Date(n.datetime);
  if (isNaN(start)) return "";
  const end = new Date(start.getTime() + 3 * 3600e3);
  const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: `Movie night: ${title || "TBC"}`,
    dates: `${f(start)}/${f(end)}`,
    location: n.location || "",
    details: n.notes || "",
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

function renderNight() {
  const el = $("#night");
  clearInterval(countdownTimer);
  if (!night || !night.datetime) {
    el.innerHTML = `<div class="night-title">Not scheduled yet</div><p class="muted">Use "Set or change movie night" below to pick a date.</p>`;
    return;
  }
  const film = movies.find((m) => m.id === night.movieId);
  const title = film ? film.title : night.movieTitle || "Film to be decided";
  const when = new Date(night.datetime);
  const whenStr = when.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const cal = gcalLink(night, title);
  const canMarkWatched = film && film.status !== "watched";

  el.innerHTML = `
    <div class="night-title">${esc(title)}${film?.year ? ` <span class="muted">(${esc(film.year)})</span>` : ""}</div>
    <div class="night-meta">
      <span>📅 ${esc(whenStr)}</span>
      ${night.location ? `<span>📍 ${esc(night.location)}</span>` : ""}
      ${film?.runtime ? `<span>⏱ ${esc(film.runtime)} min</span>` : ""}
    </div>
    ${night.notes ? `<p class="muted" style="margin:8px 0 0">${esc(night.notes)}</p>` : ""}
    <span class="countdown" id="countdown"></span>
    <div class="night-actions">
      ${cal ? `<a class="btn small" href="${esc(cal)}" target="_blank" rel="noopener">Add to Google Calendar</a>` : ""}
      ${safeUrl(film?.link) ? `<a class="btn small" href="${esc(film.link)}" target="_blank" rel="noopener">Film link</a>` : ""}
      ${canMarkWatched ? `<button class="btn small ghost" id="mark-watched">We watched it ✓</button>` : ""}
    </div>`;

  const tick = () => {
    const c = $("#countdown");
    if (!c) return;
    const ms = when - Date.now();
    if (ms <= 0) {
      c.textContent = ms > -4 * 3600e3 ? "Happening now 🍿" : "This night has passed";
      c.classList.add("past");
      return;
    }
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    c.textContent = d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m} min`;
  };
  tick();
  countdownTimer = setInterval(tick, 30e3);

  $("#mark-watched")?.addEventListener("click", () => {
    store.setStatus(film.id, "watched").then(() => toast("Moved to Already watched")).catch(fail);
  });
}

function fillNightForm() {
  const form = $("#night-form");
  const sel = form.movieId;
  const current = night?.movieId || "";
  sel.innerHTML = `<option value="">To be decided</option>` +
    pending().map((m) => `<option value="${esc(m.id)}">${esc(m.title)} (${m.votes?.length || 0} votes)</option>`).join("");
  sel.value = pending().some((m) => m.id === current) ? current : "";
  if (night?.datetime && !form.datetime.value) {
    const d = new Date(night.datetime);
    if (!isNaN(d)) form.datetime.value = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  }
  if (night && document.activeElement?.form !== form) {
    form.location.value = night.location || "";
    form.notes.value = night.notes || "";
  }
}

/* ---------- ballot ---------- */
function movieItem(m, rank, max, topVotes) {
  const n = m.votes?.length || 0;
  const mine = m.votes?.includes(store.uid);
  const leader = n > 0 && n === topVotes;
  const isOwn = m.submittedByUid === store.uid;
  const link = safeUrl(m.link);
  return `
    <li class="movie${leader ? " leader" : ""}">
      <div class="rank">${rank ?? ""}</div>
      <div>
        <h3>${esc(m.title)} ${m.year ? `<span class="yr">(${esc(m.year)})</span>` : ""}</h3>
        ${m.pitch ? `<p class="pitch">${esc(m.pitch)}</p>` : ""}
        <div class="meta">
          <span>Suggested by ${esc(m.submittedBy || "someone")}${m.createdAt ? ` · ${ago(m.createdAt)}` : ""}</span>
          ${m.runtime ? `<span>${esc(m.runtime)} min</span>` : ""}
          ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">link ↗</a>` : ""}
          <button class="linkish" data-watched="${esc(m.id)}">mark watched ✓</button>
          ${isOwn ? `<button class="linkish" data-remove="${esc(m.id)}">remove</button>` : ""}
        </div>
        <div class="bar"><i style="width:${(n / max) * 100}%"></i></div>
      </div>
      <div class="vote">
        <button class="vote-btn" data-vote="${esc(m.id)}" aria-pressed="${mine}" aria-label="${mine ? "Remove your vote for" : "Vote for"} ${esc(m.title)}">${n}<small>${n === 1 ? "vote" : "votes"}</small></button>
        <span class="vote-label">${mine ? "voted ✓" : "vote"}</span>
      </div>
    </li>`;
}

function renderBallot() {
  const list = $("#ballot");
  const all = pending();
  const active = all.filter((m) => !isDusty(m));
  const dusty = all.filter(isDusty);
  const totalVotes = all.reduce((t, m) => t + (m.votes?.length || 0), 0);
  $("#reset-votes").disabled = totalVotes === 0;

  if (!all.length) {
    list.innerHTML = `<li class="empty">No films on the shortlist yet. Suggest one!</li>`;
    $("#more").innerHTML = "";
    $("#dusty").hidden = true;
    return;
  }

  const max = Math.max(1, ...all.map((m) => m.votes?.length || 0));
  const topVotes = active[0]?.votes?.length || 0;
  const shown = showAll ? active : active.slice(0, TOP_N);
  list.innerHTML = active.length
    ? shown.map((m, i) => movieItem(m, i + 1, max, topVotes)).join("")
    : `<li class="empty">Everything's gathering dust. Vote for something below, or suggest a new film!</li>`;

  const hidden = active.length - TOP_N;
  $("#more").innerHTML = hidden > 0
    ? `<button class="btn ghost block" id="toggle-all">${showAll ? "Show top 10 only" : `Show all ${active.length} films (${hidden} more)`}</button>`
    : "";

  const d = $("#dusty");
  d.hidden = !dusty.length;
  $("#dusty-count").textContent = dusty.length;
  $("#dusty-list").innerHTML = dusty.map((m) => movieItem(m, null, max, -1)).join("");
}

function renderSubmit() {
  if (!store) return;
  const picks = myPicks();
  const box = $("#my-pick");
  const form = $("#movie-form");
  box.hidden = !picks.length;
  form.hidden = picks.length > 0;
  if (!picks.length) { box.innerHTML = ""; return; }
  const p = picks[0];
  const canRemove = p.submittedByUid === store.uid;
  const n = p.votes?.length || 0;
  box.innerHTML = `
    <span class="eyebrow">Your pick${picks.length > 1 ? `s (${picks.length})` : ""}</span>
    <div class="pick-title">${picks.map((m) => esc(m.title)).join(", ")}</div>
    <span class="muted small">${n} ${n === 1 ? "vote" : "votes"} so far${isDusty(p) ? " · gathering dust" : ""}</span>
    ${picks.length === 1 && canRemove
      ? `<button class="btn ghost small" id="swap-pick">Swap for a different film</button>`
      : `<span class="muted small">${picks.length > 1 ? "Once you're down to none, you can suggest another." : "You added this on another device. Remove it there to swap."}</span>`}`;
}

function renderHistory() {
  const list = $("#history");
  const items = watched();
  list.innerHTML = items.length
    ? items.map((m) => `<li><span>${esc(m.title)} ${m.year ? `<span class="muted">(${esc(m.year)})</span>` : ""}</span><span class="muted small">${m.watchedAt ? new Date(m.watchedAt).toLocaleDateString() : ""} · <button class="linkish" data-unwatch="${esc(m.id)}">back to shortlist</button></span></li>`).join("")
    : `<li class="muted">Nothing yet. Your first movie night will show up here.</li>`;
}

function renderAll() {
  renderNight();
  renderBallot();
  renderSubmit();
  renderHistory();
  fillNightForm();
}

/* ---------- events ---------- */
function bindEvents() {
  const ballotClick = (e) => {
    const v = e.target.closest("[data-vote]");
    if (v) {
      const id = v.dataset.vote;
      const on = v.getAttribute("aria-pressed") !== "true";
      v.disabled = true;
      store.vote(id, on).catch(fail).finally(() => { v.disabled = false; });
      return;
    }
    const w = e.target.closest("[data-watched]");
    if (w) {
      const film = movies.find((m) => m.id === w.dataset.watched);
      if (film && confirm(`Move "${film.title}" to Already watched?`)) {
        store.setStatus(film.id, "watched").then(() => toast("Moved to Already watched")).catch(fail);
      }
      return;
    }
    const r = e.target.closest("[data-remove]");
    if (r && confirm("Remove this film from the shortlist?")) {
      store.remove(r.dataset.remove).then(() => toast("Removed")).catch(fail);
    }
  };
  $("#ballot").addEventListener("click", ballotClick);
  $("#dusty-list").addEventListener("click", ballotClick);

  $("#more").addEventListener("click", (e) => {
    if (!e.target.closest("#toggle-all")) return;
    showAll = !showAll;
    renderBallot();
  });

  $("#reset-votes").addEventListener("click", () => {
    const films = pending();
    if (!films.length) return;
    if (!confirm("Start a new voting round? This clears everyone's votes on every film on the shortlist. The films stay; only the votes go.")) return;
    store.resetVotes(films.map((m) => m.id)).then(() => toast("Votes reset. New round!")).catch(fail);
  });

  $("#history").addEventListener("click", (e) => {
    const u = e.target.closest("[data-unwatch]");
    if (u) store.setStatus(u.dataset.unwatch, "pending").catch(fail);
  });

  $("#movie-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireName()) return;
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return;
    if (myPicks().length) {
      toast("You already have a film on the shortlist", true);
      renderSubmit();
      return;
    }
    if (pending().some((m) => m.title.toLowerCase() === title.toLowerCase())) {
      toast("That film is already on the shortlist", true);
      return;
    }
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      await store.addMovie({
        title,
        year: f.year.value ? Number(f.year.value) : null,
        runtime: f.runtime.value ? Number(f.runtime.value) : null,
        link: safeUrl(f.link.value.trim()),
        pitch: f.pitch.value.trim(),
        submittedBy: getName(),
      });
      f.reset();
      toast(`Added "${title}"`);
    } catch (err) { fail(err); }
    finally { btn.disabled = false; }
  });

  $("#my-pick").addEventListener("click", (e) => {
    if (!e.target.closest("#swap-pick")) return;
    const p = myPicks()[0];
    if (!p || !confirm(`Take "${p.title}" off the shortlist so you can suggest something else? Its votes will be lost.`)) return;
    store.remove(p.id).then(() => toast("Removed. Suggest your new film below.")).catch(fail);
  });

    $("#night-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireName()) return;
    const f = e.target;
    const d = new Date(f.datetime.value);
    if (isNaN(d)) { toast("Pick a date and time", true); return; }
    const film = movies.find((m) => m.id === f.movieId.value);
    try {
      await store.saveNight({
        datetime: d.toISOString(),
        location: f.location.value.trim(),
        notes: f.notes.value.trim(),
        movieId: film ? film.id : "",
        movieTitle: film ? film.title : "",
        updatedBy: getName(),
      });
      $("#night-edit").open = false;
      toast("Movie night saved");
    } catch (err) { fail(err); }
  });

  $("#pick-top").addEventListener("click", () => {
    const top = pending()[0];
    if (!top) { toast("No films on the shortlist yet", true); return; }
    $("#night-form").movieId.value = top.id;
    toast(`Selected "${top.title}". Remember to save.`);
  });
}

/* ---------- boot ---------- */
async function main() {
  renderWhoami();
  bindEvents();
  try {
    store = await createStore();
  } catch (err) {
    console.error(err);
    const b = $("#banner");
    b.hidden = false;
    b.textContent = "Couldn't connect to the database. Check your internet connection and try again. (Admin: check firebase-config.js and that Anonymous sign-in is enabled; see README.)";
    return;
  }
  if (store.mode === "demo") {
    const b = $("#banner");
    b.hidden = false;
    b.innerHTML = "<strong>Demo mode:</strong> changes are only saved in this browser. Add your Firebase settings to <code>firebase-config.js</code> so the whole club can share it (see README).";
  }
  $("#footer").textContent = store.mode === "demo" ? "Demo mode · local only" : "Live · updates for everyone automatically";
  if (store.isMember) start();
  else showGate();
}

function start() {
  $("#gate").hidden = true;
  $("#club").hidden = false;
  $("#whoami").hidden = false;
  store.onMovies((m) => { movies = m; renderAll(); }, fail);
  store.onNight((n) => { night = n; renderAll(); }, fail);
}

function showGate() {
  $("#gate").hidden = false;
  $("#club").hidden = true;
  $("#whoami").hidden = true;
  const f = $("#gate-form");
  f.name.value = getName();
  (f.name.value ? f.code : f.name).focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    const code = f.code.value.trim().toLowerCase();   // passcodes are not case-sensitive
    if (!name || !code) return;
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      await store.join(code, name);
      setName(name);
      renderWhoami();
      toast(`Welcome to the club, ${name}!`);
      start();
    } catch (err) {
      console.error(err);
      toast(err?.code === "permission-denied" ? "That passcode isn't right" : "Couldn't join. Please try again.", true);
      f.code.select();
    } finally { btn.disabled = false; }
  };
}

main();
