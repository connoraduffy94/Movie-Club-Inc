// Data layer. Two interchangeable backends with the same API:
//   - Firebase Firestore (shared, live) once firebase-config.js is filled in
//   - Demo mode (localStorage, this browser only) otherwise
//
// Data:
//   movies/{id}            the film bank. `votes` = uids who starred it ("I'd watch this").
//   meta/nextNight         date/place of the next night + closesAt (when voting ends).
//   meta/round             the current ballot: { id, number, films: [movieId], skipped: [movieId], startedAt }
//   rounds/{id}/ballots/{uid}   one member's votes for that round: { picks: [movieId] (max 3), name, updatedAt }
import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";

export function isConfigured() {
  return Boolean(firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_"));
}

export async function createStore() {
  return isConfigured() ? createFirebaseStore() : createDemoStore();
}

const CLEARED_NIGHT = { datetime: "", location: "", notes: "", closesAt: null };

/* ---------------- Firebase ---------------- */
async function createFirebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, fs, authMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);
  const auth = authMod.getAuth(app);
  // Anonymous sign-in gives each browser a stable id (for the passcode, stars and ballots).
  const cred = await authMod.signInAnonymously(auth);
  const uid = cred.user.uid;

  const moviesCol = fs.collection(db, "movies");
  const nightRef = fs.doc(db, "meta", "nextNight");
  const roundRef = fs.doc(db, "meta", "round");
  const movieRef = (id) => fs.doc(db, "movies", id);
  const memberRef = fs.doc(db, "members", uid);
  const ballotsCol = (roundId) => fs.collection(db, "rounds", roundId, "ballots");

  // Has this browser already entered the club passcode?
  const memberSnap = await fs.getDoc(memberRef);

  return {
    mode: "firebase",
    uid,
    isMember: memberSnap.exists(),
    // The rules only allow this write if `code` matches the passcode stored in config/club.
    async join(code, name) {
      await fs.setDoc(memberRef, { code, name, joinedAt: Date.now() });
      this.isMember = true;
    },

    onMovies(cb, onErr) {
      return fs.onSnapshot(moviesCol, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr);
    },
    onNight(cb, onErr) {
      return fs.onSnapshot(nightRef, (snap) => cb(snap.exists() ? snap.data() : null), onErr);
    },
    onRound(cb, onErr) {
      return fs.onSnapshot(roundRef, (snap) => cb(snap.exists() ? snap.data() : null), onErr);
    },
    onBallots(roundId, cb, onErr) {
      return fs.onSnapshot(ballotsCol(roundId), (snap) => cb(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))), onErr);
    },

    addMovie(m) {
      return fs.addDoc(moviesCol, { ...m, submittedByUid: uid, votes: [], status: "pending", createdAt: Date.now() });
    },
    star(id, on) {
      return fs.updateDoc(movieRef(id), { votes: on ? fs.arrayUnion(uid) : fs.arrayRemove(uid) });
    },
    setStatus(id, status) {
      return fs.updateDoc(movieRef(id), { status, watchedAt: status === "watched" ? Date.now() : null });
    },
    remove(id) {
      return fs.deleteDoc(movieRef(id));
    },
    saveNight(n) {
      return fs.setDoc(nightRef, { ...n, updatedAt: Date.now() });
    },
    cancelNight(updatedBy) {
      return fs.setDoc(nightRef, { ...CLEARED_NIGHT, updatedBy, updatedAt: Date.now() });
    },

    // Safely change the current round. `fn(current)` returns the new round, or null for "no change".
    // Runs in a transaction so two people's browsers can't start two rounds at once.
    updateRound(fn) {
      return fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(roundRef);
        const next = fn(snap.exists() ? snap.data() : null);
        if (next) tx.set(roundRef, next);
        return next;
      });
    },
    castBallot(roundId, picks, name) {
      return fs.setDoc(fs.doc(db, "rounds", roundId, "ballots", uid), { picks, name, updatedAt: Date.now() });
    },
    // After movie night: the winner goes to history, the night is cleared and the next round starts.
    finishNight(winnerId, nextRound, updatedBy) {
      const batch = fs.writeBatch(db);
      batch.update(movieRef(winnerId), { status: "watched", watchedAt: Date.now() });
      batch.set(nightRef, { ...CLEARED_NIGHT, updatedBy, updatedAt: Date.now() });
      batch.set(roundRef, nextRound);
      return batch.commit();
    },
  };
}

/* ---------------- Demo (localStorage) ---------------- */
function createDemoStore() {
  const KEY = "movieclub-demo-v2";
  const UID_KEY = "movieclub-demo-uid";
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

  let uid = safeGet(UID_KEY);
  if (!uid) { uid = "demo-" + Math.random().toString(36).slice(2); safeSet(UID_KEY, uid); }

  const day = 864e5;
  const film = (id, title, year, runtime, by, stars, age, pitch = "") =>
    ({ id, title, year, runtime, link: "", pitch, submittedBy: by, submittedByUid: "x-" + by, votes: stars, status: "pending", createdAt: Date.now() - age * day });
  const seed = () => ({
    movies: [
      film("m1", "Paddington 2", 2017, 103, "Sam", ["a", "b", "c"], 40, "Guaranteed crowd-pleaser."),
      film("m2", "Arrival", 2016, 116, "Alex", ["a", "b"], 30),
      film("m3", "Heat", 1995, 170, "Jo", ["a"], 90, "Long, but worth it."),
      film("m4", "Spirited Away", 2001, 125, "Priya", ["b", "c"], 10),
      film("m5", "The Thing", 1982, 109, "Sam", [], 120),
      film("m6", "Knives Out", 2019, 130, "Alex", ["c"], 5),
      film("m7", "Moonlight", 2016, 111, "Jo", [], 60),
    ],
    night: null,
    round: null,
    ballots: {},
  });

  let state;
  try { state = JSON.parse(safeGet(KEY)) || seed(); } catch { state = seed(); }
  const subs = { movies: new Set(), night: new Set(), round: new Set(), ballots: new Set() };
  const clone = (v) => (v == null ? null : structuredClone(v));
  const ballotsFor = (rid) => Object.entries(state.ballots[rid] || {}).map(([u, b]) => ({ uid: u, ...b }));
  const emit = () => {
    safeSet(KEY, JSON.stringify(state));
    subs.movies.forEach((cb) => cb(clone(state.movies)));
    subs.night.forEach((cb) => cb(clone(state.night)));
    subs.round.forEach((cb) => cb(clone(state.round)));
    subs.ballots.forEach(([rid, cb]) => cb(clone(ballotsFor(rid))));
  };
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    try { state = JSON.parse(e.newValue) || seed(); } catch { return; }
    emit();
  });
  const find = (id) => state.movies.find((m) => m.id === id);
  const sub = (set, item, first) => { set.add(item); first(); return () => set.delete(item); };

  return {
    mode: "demo",
    uid,
    isMember: true,           // no passcode in demo mode
    async join() {},
    onMovies(cb) { return sub(subs.movies, cb, () => cb(clone(state.movies))); },
    onNight(cb) { return sub(subs.night, cb, () => cb(clone(state.night))); },
    onRound(cb) { return sub(subs.round, cb, () => cb(clone(state.round))); },
    onBallots(rid, cb) { const item = [rid, cb]; return sub(subs.ballots, item, () => cb(clone(ballotsFor(rid)))); },

    async addMovie(m) {
      state.movies.push({ ...m, id: "m" + Date.now(), submittedByUid: uid, votes: [], status: "pending", createdAt: Date.now() });
      emit();
    },
    async star(id, on) {
      const m = find(id); if (!m) return;
      m.votes = m.votes.filter((v) => v !== uid);
      if (on) m.votes.push(uid);
      emit();
    },
    async setStatus(id, status) {
      const m = find(id); if (!m) return;
      m.status = status; m.watchedAt = status === "watched" ? Date.now() : null;
      emit();
    },
    async remove(id) { state.movies = state.movies.filter((m) => m.id !== id); emit(); },
    async saveNight(n) { state.night = { ...n, updatedAt: Date.now() }; emit(); },
    async cancelNight(updatedBy) { state.night = { ...CLEARED_NIGHT, updatedBy, updatedAt: Date.now() }; emit(); },
    async updateRound(fn) {
      const next = fn(clone(state.round));
      if (next) { state.round = next; emit(); }
      return next;
    },
    async castBallot(rid, picks, name) {
      (state.ballots[rid] ||= {})[uid] = { picks, name, updatedAt: Date.now() };
      emit();
    },
    async finishNight(winnerId, nextRound, updatedBy) {
      const m = find(winnerId);
      if (m) { m.status = "watched"; m.watchedAt = Date.now(); }
      state.night = { ...CLEARED_NIGHT, updatedBy, updatedAt: Date.now() };
      state.round = nextRound;
      emit();
    },
  };
}
