// Data layer. Two interchangeable backends with the same API:
//   - Firebase Firestore (shared, live) once firebase-config.js is filled in
//   - Demo mode (localStorage, this browser only) otherwise
import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";

export function isConfigured() {
  return Boolean(firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_"));
}

export async function createStore() {
  return isConfigured() ? createFirebaseStore() : createDemoStore();
}

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
  // Anonymous sign-in gives each browser a stable id, used for one-vote-per-person.
  const cred = await authMod.signInAnonymously(auth);
  const uid = cred.user.uid;

  const moviesCol = fs.collection(db, "movies");
  const nightRef = fs.doc(db, "meta", "nextNight");
  const movieRef = (id) => fs.doc(db, "movies", id);
  const memberRef = fs.doc(db, "members", uid);

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
    addMovie(m) {
      return fs.addDoc(moviesCol, { ...m, submittedByUid: uid, votes: [], status: "pending", createdAt: Date.now() });
    },
    vote(id, on) {
      return fs.updateDoc(movieRef(id), { votes: on ? fs.arrayUnion(uid) : fs.arrayRemove(uid) });
    },
    setStatus(id, status) {
      return fs.updateDoc(movieRef(id), { status, watchedAt: status === "watched" ? Date.now() : null });
    },
    remove(id) {
      return fs.deleteDoc(movieRef(id));
    },
    // Clear every vote on the given films and start a new round.
    resetVotes(ids) {
      const batch = fs.writeBatch(db);
      const now = Date.now();
      ids.forEach((id) => batch.update(movieRef(id), { votes: [], roundStartedAt: now }));
      return batch.commit();
    },
    saveNight(n) {
      return fs.setDoc(nightRef, { ...n, updatedAt: Date.now() });
    },
  };
}

/* ---------------- Demo (localStorage) ---------------- */
function createDemoStore() {
  const KEY = "movieclub-demo-v1";
  const UID_KEY = "movieclub-demo-uid";
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

  let uid = safeGet(UID_KEY);
  if (!uid) { uid = "demo-" + Math.random().toString(36).slice(2); safeSet(UID_KEY, uid); }

  const seed = () => ({
    movies: [
      { id: "m1", title: "Paddington 2", year: 2017, runtime: 103, link: "", pitch: "Guaranteed crowd-pleaser.", submittedBy: "Demo", submittedByUid: "x", votes: ["a", "b"], status: "pending", createdAt: Date.now() - 3e5 },
      { id: "m2", title: "Arrival", year: 2016, runtime: 116, link: "", pitch: "", submittedBy: "Demo", submittedByUid: "x", votes: ["a"], status: "pending", createdAt: Date.now() - 2e5 },
    ],
    night: null,
  });

  let state;
  try { state = JSON.parse(safeGet(KEY)) || seed(); } catch { state = seed(); }
  const movieSubs = new Set();
  const nightSubs = new Set();
  const emit = () => {
    safeSet(KEY, JSON.stringify(state));
    movieSubs.forEach((cb) => cb(structuredClone(state.movies)));
    nightSubs.forEach((cb) => cb(state.night ? structuredClone(state.night) : null));
  };
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    try { state = JSON.parse(e.newValue) || seed(); } catch { return; }
    emit();
  });
  const find = (id) => state.movies.find((m) => m.id === id);

  return {
    mode: "demo",
    uid,
    isMember: true,           // no passcode in demo mode
    async join() {},
    onMovies(cb) { movieSubs.add(cb); cb(structuredClone(state.movies)); return () => movieSubs.delete(cb); },
    onNight(cb) { nightSubs.add(cb); cb(state.night ? structuredClone(state.night) : null); return () => nightSubs.delete(cb); },
    async addMovie(m) {
      state.movies.push({ ...m, id: "m" + Date.now(), submittedByUid: uid, votes: [], status: "pending", createdAt: Date.now() });
      emit();
    },
    async vote(id, on) {
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
    async resetVotes(ids) {
      const now = Date.now();
      ids.forEach((id) => { const m = find(id); if (m) { m.votes = []; m.roundStartedAt = now; } });
      emit();
    },
    async remove(id) { state.movies = state.movies.filter((m) => m.id !== id); emit(); },
    async saveNight(n) { state.night = { ...n, updatedAt: Date.now() }; emit(); },
  };
}
