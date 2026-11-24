import { createStore } from "./store.js";

/* ---------- settings ---------- */
const BALLOT_SIZE = 6;          // films on each round's ballot
const BY_STARS = 4;             // ...of which this many are the most-starred (the rest are the longest-waiting)
const VOTES_EACH = 3;           // votes per person per round
const CLOSE_BEFORE = 24 * 36e5; // voting closes this long before movie night
const BANK_SHOW = 15;           // films shown in the bank before "Show all"

const $ = (sel) => document.querySelector(sel);
const NAME_KEY = "movieclub-name";

let store;
let movies = [];
let night = null;
let round = null;
let ballots = [];
let loaded = { movies: false, round: false };
let ballotsUnsub = null, ballotsRoundId = null;
let showAll = false;
let search = "";
let reconcileBusy = false, reconcileFailed = false;

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const getName = () => { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } };
const setName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2800);
}

function fail(err) {
  console.error(err);
  toast(err?.code === "permission-denied" ? "Not allowed. Voting may have closed, or the Firestore rules need updating." : "Something went wrong. Please try again.", true);
}

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

/* ---------- derived data ---------- */
const byId = (id) => movies.find((m) => m.id === id);
const stars = (m) => m.votes?.length || 0;
// Film bank: everything not yet watched. Most stars first, then longest-waiting.
const bank = () => movies.filter((m) => m.status !== "watched")
  .sort((a, b) => stars(b) - stars(a) || a.createdAt - b.createdAt);
const watched = () => movies.filter((m) => m.status === "watched")
  .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));

const nightSet = () => Boolean(night?.datetime);
// A night where someone chose a specific film instead of voting. Voting carries on to the next night.
const chosenNight = () => nightSet() && Boolean(night.movieId);
const chosenFilm = () => (chosenNight() ? byId(night.movieId) || { id: night.movieId, title: night.movieTitle || "Chosen film", gone: true } : null);
const closesAt = () => (nightSet() && night.closesAt ? night.closesAt : null);
const votingOpen = () => !closesAt() || Date.now() < closesAt();

// Films on the current ballot that are still in the bank.
const ballotFilms = () => (round?.films || []).map(byId).filter((m) => m && m.status !== "watched");

function tally() {
  const ids = new Set(ballotFilms().map((m) => m.id));
  const count = {}, voters = {};
  for (const b of ballots) {
    for (const id of b.picks || []) {
      if (!ids.has(id)) continue;
      count[id] = (count[id] || 0) + 1;
      (voters[id] ||= []).push(b.name || "someone");
    }
  }
  return { count, voters };
}
// Ballot in ranked order. Ties go to the film that has waited longest.
function ranked() {
  const { count } = tally();
  return ballotFilms().sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0) || a.createdAt - b.createdAt);
}
const leader = () => ranked()[0] || null;
const myPicks = () => {
  const ids = new Set(ballotFilms().map((m) => m.id));
  return (ballots.find((b) => b.uid === store.uid)?.picks || []).filter((id) => ids.has(id));
};

/* ---------- choosing a ballot ---------- */
// Keep `keep`, then fill up to BALLOT_SIZE: most-starred first (up to BY_STARS), then longest-waiting.
// At most one film per person who suggested it, unless there aren't enough films otherwise.
function pickBallot(keep = [], exclude = []) {
  const who = (m) => (m.submittedBy || "").trim().toLowerCase() || m.submittedByUid;
  const chosen = keep.map(byId).filter((m) => m && m.status !== "watched");
  const used = new Set(chosen.map(who));
  const skip = new Set([...exclude, ...chosen.map((m) => m.id)]);
  const pool = bank().filter((m) => !skip.has(m.id));
  const add = (m, distinct) => {
    if (chosen.length >= BALLOT_SIZE || chosen.includes(m)) return;
    if (distinct && used.has(who(m))) return;
    chosen.push(m); used.add(who(m));
  };
  for (const m of pool) { if (chosen.length >= BY_STARS || !stars(m)) break; add(m, true); }
  const oldest = [...pool].sort((a, b) => a.createdAt - b.createdAt);
  oldest.forEach((m) => add(m, true));
  oldest.forEach((m) => add(m, false));
  return chosen.map((m) => m.id);
}

const newRound = (prev, exclude = []) => ({
  id: "r" + Date.now(),
  number: (prev?.number || 0) + 1,
  films: pickBallot([], exclude),
  skipped: [],
  startedAt: Date.now(),
});
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Start the first round automatically, and top up an under-full ballot while voting is open.
async function reconcile() {
  if (!loaded.movies || !loaded.round || reconcileBusy || reconcileFailed) return;
  let fn = null;
  if (!round) {
    if (bank().length) fn = (cur) => (cur ? null : newRound(null));
  } else if (votingOpen() && ballotFilms().length < BALLOT_SIZE) {
    const active = ballotFilms().map((m) => m.id);
    if (pickBallot(active, round.skipped || []).length > active.length) {
      fn = (cur) => {
        if (!cur || cur.id !== round.id) return null;
        const films = pickBallot(cur.films.filter((id) => byId(id)?.status === "pending"), cur.skipped || []);
        return sameList(films, cur.films) ? null : { ...cur, films };
      };
    }
  }
  if (!fn) return;
  reconcileBusy = true;
  try { await store.updateRound(fn); }
  catch (err) { reconcileFailed = true; fail(err); }
  finally { reconcileBusy = false; }
}

/* ---------- who am I ---------- */
function renderWhoami() {
  const el = $("#whoami");
  const name = getName();
  if (name) {
    el.innerHTML = `<span class="muted">Hi,</span> <strong>${esc(name)}</strong> <button class="linkish" id="change-name">change</button>`;
    $("#change-name").onclick = () => { setName(""); renderWhoami(); };
  } else {
    el.innerHTML = `<form id="name-form" class="whoami"><input name="n" maxlength="40" placeholder="Your name" required aria-label="Your name"><button class="btn small primary">Save</button></form>`;
    $("#name-form").onsubmit = (e) => {
      e.preventDefault();
      const n = e.target.n.value.trim();
      if (n) { setName(n); renderWhoami(); toast(`Welcome, ${n}!`); }
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

function countdown(when) {
  const ms = when - Date.now();
  if (ms <= 0) return { text: ms > -4 * 3600e3 ? "Happening now 🍿" : "This night has passed", past: true };
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return { text: d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m} min`, past: false };
}

function renderNight() {
  const el = $("#night");
  const top = leader();
  const { count } = tally();
  const leadLine = top
    ? `Currently leading: <strong>${esc(top.title)}</strong> (${plural(count[top.id] || 0, "vote")})`
    : "No films on the ballot yet. Suggest one below!";

  if (!nightSet()) {
    el.innerHTML = `
      <div class="night-title">Not scheduled yet</div>
      <p class="muted" style="margin:0">Voting is open. It closes 24 hours before the next movie night, once one is set.</p>
      <p style="margin:8px 0 0">🗳 ${leadLine}</p>`;
    return;
  }

  if (chosenNight()) return renderChosenNight(el, leadLine);

  const open = votingOpen();
  const when = new Date(night.datetime);
  const title = open ? "Film decided by vote" : top ? top.title : "No film chosen";
  const cal = gcalLink(night, open ? "" : top?.title);
  const cd = countdown(when);

  el.innerHTML = `
    <div class="night-title">${esc(title)}${!open && top?.year ? ` <span class="muted">(${esc(top.year)})</span>` : ""}</div>
    <div class="night-meta">
      <span>📅 ${esc(when.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}</span>
      ${night.location ? `<span>📍 ${esc(night.location)}</span>` : ""}
      ${!open && top?.runtime ? `<span>⏱ ${esc(top.runtime)} min</span>` : ""}
    </div>
    ${night.notes ? `<p class="muted" style="margin:8px 0 0">${esc(night.notes)}</p>` : ""}
    <p style="margin:8px 0 0">${open
      ? `🗳 ${leadLine}<br><span class="muted small">Voting closes ${esc(fmtWhen(closesAt()))}</span>`
      : `🗳 <span class="muted">Voting has closed${top ? ` · ${plural(count[top.id] || 0, "vote")}` : ""}</span>`}</p>
    <span class="countdown${cd.past ? " past" : ""}">${esc(cd.text)}</span>
    <div class="night-actions">
      ${cal ? `<a class="btn small" href="${esc(cal)}" target="_blank" rel="noopener">Add to Google Calendar</a>` : ""}
      ${!open && safeUrl(top?.link) ? `<a class="btn small" href="${esc(top.link)}" target="_blank" rel="noopener">Film link</a>` : ""}
      ${!open && top ? `<button class="btn small primary" id="finish-night">We watched it ✓ · start next round</button>` : ""}
    </div>`;
}

function renderChosenNight(el, leadLine) {
  const film = chosenFilm();
  const when = new Date(night.datetime);
  const cal = gcalLink(night, film.title);
  const cd = countdown(when);
  const canFinish = !film.gone && film.status !== "watched";
  el.innerHTML = `
    <div class="night-title">${esc(film.title)}${film.year ? ` <span class="muted">(${esc(film.year)})</span>` : ""}</div>
    <div class="night-meta">
      <span>📅 ${esc(when.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}</span>
      ${night.location ? `<span>📍 ${esc(night.location)}</span>` : ""}
      ${film.runtime ? `<span>⏱ ${esc(film.runtime)} min</span>` : ""}
      <span>🎟 Chosen film${night.updatedBy ? ` · picked by ${esc(night.updatedBy)}` : ""}</span>
    </div>
    ${night.notes ? `<p class="muted" style="margin:8px 0 0">${esc(night.notes)}</p>` : ""}
    <p style="margin:8px 0 0">🗳 <span class="muted small">The vote carries on to the next night.</span><br>${leadLine}</p>
    <span class="countdown${cd.past ? " past" : ""}">${esc(cd.text)}</span>
    <div class="night-actions">
      ${cal ? `<a class="btn small" href="${esc(cal)}" target="_blank" rel="noopener">Add to Google Calendar</a>` : ""}
      ${safeUrl(film.link) ? `<a class="btn small" href="${esc(film.link)}" target="_blank" rel="noopener">Film link</a>` : ""}
      ${canFinish ? `<button class="btn small primary" id="finish-night">We watched it ✓</button>` : ""}
    </div>`;
}

function fillNightForm() {
  const form = $("#night-form");
  $("#cancel-night").hidden = !nightSet();
  if (document.activeElement?.form === form) return;   // don't overwrite while someone is typing
  const films = bank().slice().sort((a, b) => a.title.localeCompare(b.title));
  const current = chosenNight() ? night.movieId : "";
  form.movieId.innerHTML = `<option value="">🗳 Decided by vote</option>` +
    films.map((m) => `<option value="${esc(m.id)}">${esc(m.title)}${m.year ? ` (${esc(m.year)})` : ""}</option>`).join("");
  form.movieId.value = films.some((m) => m.id === current) ? current : "";
  updateNightFormHelp();
  if (nightSet()) {
    const d = new Date(night.datetime);
    if (!isNaN(d)) form.datetime.value = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  } else {
    form.datetime.value = "";
  }
  form.location.value = night?.location || "";
  form.notes.value = night?.notes || "";
}

function updateNightFormHelp() {
  const hours = CLOSE_BEFORE / 36e5;
  $("#night-form-help").textContent = $("#night-form").movieId.value
    ? "This night will show the chosen film. Voting isn't affected: the ballot and votes carry over to the next night."
    : `Voting closes ${hours} hours before the night (or when it starts, if that's sooner). The top film wins. To watch a particular film instead, pick it above (add it to the bank first).`;
}

/* ---------- ballot ---------- */
function renderBallot() {
  const list = $("#ballot");
  const open = votingOpen();
  const films = ranked();
  const { count, voters } = tally();
  const mine = myPicks();
  const left = VOTES_EACH - mine.length;

  $("#round-status").textContent = round ? `Round ${round.number} · ${open ? "voting open" : "voting closed"}` : "";
  $("#round-status").classList.toggle("closed", !open);
  $("#ballot-help").textContent = !films.length ? ""
    : open
      ? `You have ${left} of ${VOTES_EACH} votes left. Click a film to vote, click again to take it back.${closesAt() ? ` Closes ${fmtWhen(closesAt())}.` : ""}`
      : "Voting has closed. The winner is shown above.";

  if (!films.length) {
    list.innerHTML = `<li class="empty">The ballot is empty. Suggest a film below and it'll appear here.</li>`;
    return;
  }
  const max = Math.max(1, ...films.map((m) => count[m.id] || 0));
  const topVotes = count[films[0].id] || 0;
  list.innerHTML = films.map((m, i) => {
    const n = count[m.id] || 0;
    const on = mine.includes(m.id);
    const lead = i === 0 && (topVotes > 0 || !open);
    const link = safeUrl(m.link);
    return `
    <li class="movie${lead ? " leader" : ""}">
      <div class="rank">${i + 1}</div>
      <div>
        <h3>${esc(m.title)} ${m.year ? `<span class="yr">(${esc(m.year)})</span>` : ""}</h3>
        ${m.pitch ? `<p class="pitch">${esc(m.pitch)}</p>` : ""}
        <div class="meta">
          <span>Suggested by ${esc(m.submittedBy || "someone")}</span>
          ${m.runtime ? `<span>${esc(m.runtime)} min</span>` : ""}
          ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">link ↗</a>` : ""}
          ${open ? `<button class="linkish" data-swap="${esc(m.id)}">swap out</button>` : ""}
        </div>
        ${n ? `<div class="voters">🗳 ${esc(voters[m.id].join(", "))}</div>` : ""}
        <div class="bar"><i style="width:${(n / max) * 100}%"></i></div>
      </div>
      <div class="vote">
        <button class="vote-btn" data-vote="${esc(m.id)}" aria-pressed="${on}" ${open ? "" : "disabled"} aria-label="${on ? "Take back your vote for" : "Vote for"} ${esc(m.title)}">${n}<small>${n === 1 ? "vote" : "votes"}</small></button>
        <span class="vote-label">${on ? "voted ✓" : open ? "vote" : ""}</span>
      </div>
    </li>`;
  }).join("");
}

/* ---------- film bank ---------- */
function renderBank() {
  const list = $("#bank");
  const onBallot = new Set(ballotFilms().map((m) => m.id));
  const q = search.trim().toLowerCase();
  const all = bank().filter((m) => !q || m.title.toLowerCase().includes(q) || (m.submittedBy || "").toLowerCase().includes(q));
  const shown = showAll || q ? all : all.slice(0, BANK_SHOW);

  list.innerHTML = shown.length ? shown.map((m) => {
    const n = stars(m);
    const starred = m.votes?.includes(store.uid);
    const link = safeUrl(m.link);
    return `
    <li class="bank-item">
      <button class="star-btn" data-star="${esc(m.id)}" aria-pressed="${!!starred}" aria-label="${starred ? "Unstar" : "Star"} ${esc(m.title)}" title="I'd watch this">${starred ? "★" : "☆"} ${n}</button>
      <div>
        <h3>${esc(m.title)} ${m.year ? `<span class="yr">(${esc(m.year)})</span>` : ""} ${onBallot.has(m.id) ? `<span class="badge">on ballot</span>` : ""}</h3>
        ${m.pitch ? `<p class="pitch">${esc(m.pitch)}</p>` : ""}
        <div class="meta">
          <span>${esc(m.submittedBy || "someone")} · ${ago(m.createdAt)}</span>
          ${m.runtime ? `<span>${esc(m.runtime)} min</span>` : ""}
          ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">link ↗</a>` : ""}
          <button class="linkish" data-watched="${esc(m.id)}">mark watched</button>
          ${m.submittedByUid === store.uid ? `<button class="linkish" data-remove="${esc(m.id)}">remove</button>` : ""}
        </div>
      </div>
    </li>`;
  }).join("") : `<li class="empty">${q ? "No films match that search." : "The bank is empty. Suggest the first film!"}</li>`;

  const hidden = all.length - BANK_SHOW;
  $("#more").innerHTML = !q && hidden > 0
    ? `<button class="btn ghost block" id="toggle-all">${showAll ? `Show top ${BANK_SHOW} only` : `Show all ${all.length} films (${hidden} more)`}</button>`
    : "";
}

function renderHistory() {
  const list = $("#history");
  const items = watched();
  list.innerHTML = items.length
    ? items.map((m) => `<li><span>${esc(m.title)} ${m.year ? `<span class="muted">(${esc(m.year)})</span>` : ""}</span><span class="muted small">${m.watchedAt ? new Date(m.watchedAt).toLocaleDateString() : ""} · <button class="linkish" data-unwatch="${esc(m.id)}">back to bank</button></span></li>`).join("")
    : `<li class="muted">Nothing yet. Your first movie night will show up here.</li>`;
}

function renderAll() {
  renderNight();
  renderBallot();
  renderBank();
  renderHistory();
  fillNightForm();
  reconcile();
}

/* ---------- actions ---------- */
function toggleVote(id, btn) {
  if (!round || !requireName()) return;
  if (!votingOpen()) { toast("Voting has closed for this round", true); return; }
  const picks = myPicks();
  const on = !picks.includes(id);
  if (on && picks.length >= VOTES_EACH) { toast(`You've used all ${VOTES_EACH} votes. Take one back first.`, true); return; }
  btn.disabled = true;
  store.castBallot(round.id, on ? [...picks, id] : picks.filter((p) => p !== id), getName())
    .catch(fail).finally(() => { btn.disabled = false; });
}

function swapOut(id) {
  const m = byId(id);
  if (!m || !round) return;
  const n = tally().count[id] || 0;
  if (!confirm(`Swap "${m.title}" off this ballot for another film from the bank?${n ? ` Its ${plural(n, "vote")} will be lost.` : ""} It stays in the bank for future rounds.`)) return;
  const rid = round.id;
  store.updateRound((cur) => {
    if (!cur || cur.id !== rid) return null;
    const skipped = [...(cur.skipped || []), id].slice(-100);
    const keep = cur.films.filter((f) => f !== id && byId(f)?.status === "pending");
    return { ...cur, skipped, films: pickBallot(keep, skipped) };
  }).then(() => toast(`Swapped out "${m.title}"`)).catch(fail);
}

function finishNight() {
  if (chosenNight()) {
    const f = chosenFilm();
    if (!f || f.gone || !confirm(`Mark "${f.title}" as watched? The current vote carries on to the next night.`)) return;
    store.finishNight(f.id, null, getName()).then(() => toast("Enjoy the film! The vote carries on.")).catch(fail);
    return;
  }
  const w = leader();
  if (!w || !confirm(`Mark "${w.title}" as watched and start the next round with a fresh ballot?`)) return;
  store.finishNight(w.id, newRound(round, [w.id]), getName())
    .then(() => toast("Enjoy the film! A new round has started."))
    .catch(fail);
}

/* ---------- events ---------- */
function bindEvents() {
  $("#ballot").addEventListener("click", (e) => {
    const v = e.target.closest("[data-vote]");
    if (v) return toggleVote(v.dataset.vote, v);
    const s = e.target.closest("[data-swap]");
    if (s) swapOut(s.dataset.swap);
  });

  $("#bank").addEventListener("click", (e) => {
    const s = e.target.closest("[data-star]");
    if (s) {
      s.disabled = true;
      store.star(s.dataset.star, s.getAttribute("aria-pressed") !== "true").catch(fail).finally(() => { s.disabled = false; });
      return;
    }
    const w = e.target.closest("[data-watched]");
    if (w) {
      const film = byId(w.dataset.watched);
      if (film && confirm(`Move "${film.title}" to Already watched? (For films you've seen outside movie night.)`)) {
        store.setStatus(film.id, "watched").then(() => toast("Moved to Already watched")).catch(fail);
      }
      return;
    }
    const r = e.target.closest("[data-remove]");
    if (r && confirm("Remove this film from the bank?")) {
      store.remove(r.dataset.remove).then(() => toast("Removed")).catch(fail);
    }
  });

  $("#bank-search").addEventListener("input", (e) => { search = e.target.value; renderBank(); });
  $("#more").addEventListener("click", (e) => {
    if (!e.target.closest("#toggle-all")) return;
    showAll = !showAll;
    renderBank();
  });

  $("#night").addEventListener("click", (e) => {
    if (e.target.closest("#finish-night")) finishNight();
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
    if (bank().some((m) => m.title.toLowerCase() === title.toLowerCase())) {
      toast("That film is already in the bank", true);
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
      toast(`Added "${title}" to the bank`);
    } catch (err) { fail(err); }
    finally { btn.disabled = false; }
  });

  $("#night-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireName()) return;
    const f = e.target;
    const d = new Date(f.datetime.value);
    if (isNaN(d)) { toast("Pick a date and time", true); return; }
    // Close 24h before; if the night is sooner than that, voting stays open until it starts.
    // A chosen film doesn't close voting: the round carries on to the next night.
    const film = byId(f.movieId.value);
    const close = film ? null : d.getTime() - CLOSE_BEFORE > Date.now() ? d.getTime() - CLOSE_BEFORE : d.getTime();
    try {
      await store.saveNight({
        datetime: d.toISOString(),
        location: f.location.value.trim(),
        notes: f.notes.value.trim(),
        closesAt: close,
        movieId: film ? film.id : "",
        movieTitle: film ? film.title : "",
        updatedBy: getName(),
      });
      $("#night-edit").open = false;
      toast(film ? `Movie night saved: ${film.title}` : `Movie night saved. Voting closes ${fmtWhen(close)}.`);
    } catch (err) { fail(err); }
  });

  $("#night-form").movieId.addEventListener("change", updateNightFormHelp);

  $("#cancel-night").addEventListener("click", () => {
    if (!confirm("Cancel this movie night? Votes are kept and voting stays open until a new night is set.")) return;
    store.cancelNight(getName()).then(() => { $("#night-edit").open = false; toast("Movie night cancelled"); }).catch(fail);
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

function subscribeBallots() {
  const rid = round?.id || null;
  if (rid === ballotsRoundId) return;
  ballotsUnsub?.();
  ballots = [];
  ballotsRoundId = rid;
  ballotsUnsub = rid ? store.onBallots(rid, (b) => { ballots = b; renderAll(); }, fail) : null;
}

const HELP_SEEN_KEY = "movieclub-help-seen";
function setupHelp() {
  // Keep the numbers in the help text in sync with the settings above.
  const hours = CLOSE_BEFORE / 36e5;
  const values = { ballot: BALLOT_SIZE, stars: BY_STARS, votes: VOTES_EACH, close: `${hours} ${hours === 1 ? "hour" : "hours"}` };
  document.querySelectorAll("[data-setting]").forEach((el) => { el.textContent = values[el.dataset.setting]; });

  const help = $("#help");
  // Open automatically on someone's first visit.
  let seen = false;
  try { seen = localStorage.getItem(HELP_SEEN_KEY) === "1"; localStorage.setItem(HELP_SEEN_KEY, "1"); } catch { /* ignore */ }
  help.open = !seen;

  const link = $("#help-link");
  link.hidden = false;
  link.onclick = () => {
    help.open = true;
    help.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

function start() {
  $("#gate").hidden = true;
  $("#club").hidden = false;
  $("#whoami").hidden = false;
  setupHelp();
  store.onMovies((m) => { movies = m; loaded.movies = true; renderAll(); }, fail);
  store.onNight((n) => { night = n; renderAll(); }, fail);
  store.onRound((r) => { round = r; loaded.round = true; subscribeBallots(); renderAll(); }, fail);
  // Keep countdowns fresh and flip to "voting closed" on time.
  setInterval(renderAll, 30e3);
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
