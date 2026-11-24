# 🎬 Movie Club

A small website for our movie club. Live at https://connoraduffy94.github.io/Movie-Club-Inc/ (members only: needs the club passcode).

**How a round works**
1. **Film bank.** Anyone can suggest as many films as they like. Star (☆) the ones you'd happily watch; stars carry over between rounds.
2. **Ballot.** Each round gets a ballot of 6 films, picked automatically: the 4 most-starred, then the ones that have waited longest. There's at most one film per person, unless there aren't enough otherwise. Anyone can **swap out** a ballot film; it stays in the bank.
3. **Voting.** Everyone gets **3 votes** per round. Voting closes **24 hours before movie night** (or when it starts, if it was scheduled less than 24 hours ahead). With no night scheduled, voting stays open and the ballot shows who's leading.
4. **Winner.** The film with the most votes wins. Ties go to the film that has waited longest in the bank.
5. **After the night**, press **"We watched it ✓ · start next round"**. The winner moves to *Already watched*, the night is cleared, and a fresh ballot is drawn automatically.

**Watching a particular film:** when setting the night, pick a film under *Film* instead of "Decided by vote". That night shows the chosen film, voting isn't closed, and the ballot and votes carry over to the next night. "We watched it ✓" then moves that film to history without starting a new round.

Also: a "How it works" help section, a countdown and "Add to Google Calendar" link for the next night, a **Cancel this night** button (votes are kept), search in the bank, and a history of watched films.

It's a plain static site (HTML/CSS/JS, no build step) hosted free on **GitHub Pages**. The shared data (films, votes, next night) lives in a free **Firebase Firestore** database.

Until Firebase is set up, the site runs in **demo mode**: it works fully, but only saves to your own browser.

---

## Try it locally
```bash
cd ~/Documents/movie-club
python3 -m http.server 8000
```
Then open http://localhost:8000. (Opening `index.html` directly won't work, because ES modules need a web server.)

---

## Step 1: Create the shared database (Firebase, ~10 min, free)
1. Go to https://console.firebase.google.com, then **Add project**. Call it something like `movie-club`. Google Analytics isn't needed.
   > Firebase moves its menus around. If you can't find a section below, search for it in the bar at the top of the console, or click **All products** in the left sidebar (on a narrow window, open the sidebar with ☰ first).
2. **Firestore Database → Create database.** Pick a location near you (e.g. `europe-west2` London) and start in **production mode**.
3. **Authentication → Get started → Sign-in method → Anonymous → Enable.** This gives each browser an invisible ID, so people can't vote twice. Nobody has to make an account.
4. **Firestore → Rules tab:** replace everything with the contents of [`firestore.rules`](firestore.rules), then **Publish**.
5. **Set the club passcode.** In **Firestore Database → Data**, click **+ Start collection**. Collection ID: `config`. Document ID: `club`. Add one field: name `code`, type **string**, value your passcode **in lowercase**, e.g. `popcorn and pickles`. Save. (What people type is lowercased, so the passcode isn't case-sensitive.)
6. **Project settings (⚙️) → General → Your apps → Web (`</>`)**: register an app (no hosting needed). Copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js).

> The Firebase web config isn't a secret. It's designed to be public, and the security rules are what protect the data.

## Step 2: Publish on GitHub Pages
1. Create a new **public** repository on github.com, e.g. `movie-club`. Don't add a README; this folder already has one.
2. Push this folder:
   ```bash
   cd ~/Documents/movie-club
   git init -b main
   git add .
   git commit -m "Movie club site"
   git remote add origin https://github.com/<your-username>/movie-club.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**
4. After a minute the site is live at `https://<your-username>.github.io/movie-club/`.
5. In Firebase, go to **Authentication → Settings → Authorized domains → Add domain** and add `<your-username>.github.io`.

Share the link with the club. Updates appear for everyone instantly, with no refresh needed.

---

## How it works
| File | What it does |
|---|---|
| `index.html` | Page layout |
| `style.css` | Cinema-themed styling, works on phones |
| `app.js` | Rendering, forms, ballot selection, voting, countdown. Settings at the top |
| `store.js` | Data layer: Firestore when configured, browser-only demo otherwise |
| `firebase-config.js` | Your Firebase project settings |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

**Data in Firestore**
- `movies/{id}`: the film bank. `title, year, runtime, link, pitch, submittedBy, submittedByUid, votes[] (uids who starred it), status ('pending'|'watched'), createdAt, watchedAt`
- `meta/nextNight`: `datetime (ISO, "" if none), location, notes, closesAt (ms, null for a chosen-film night), movieId/movieTitle (chosen film, "" if decided by vote), updatedBy, updatedAt`
- `meta/round`: the current ballot. `id, number, films[], skipped[], startedAt`
- `rounds/{roundId}/ballots/{uid}`: one member's votes for a round. `picks[] (max 3), name, updatedAt`
- `members/{uid}`: `name, code, joinedAt`: one per browser that has entered the passcode
- `config/club`: `code`: the club passcode (set by hand, unreadable from the site)

**What the rules enforce**
- Only **members** (browsers that entered the passcode) can see or change anything. Strangers with the link see only the passcode screen.
- Each member has **one ballot per round with at most 3 votes**, only for films on that round's ballot, and **only while voting is open**.
- Each browser can add or remove **only its own star**.
- Only the person who suggested a film can delete it.
- Field sizes are capped. Any member can set or cancel the movie night, swap ballot films, and mark films as watched.

## Good to know
- **Passcode.** Share it only with the club. To **change it**, edit `config/club` in the Firebase console. That stops new people joining with the old code, but anyone who already joined stays in.
- **Removing someone:** in **Firestore Database → Data → members**, find their document (it shows their name) and delete it. They'll need the current passcode to get back in.
- **Settings** (ballot size, how many films are chosen by stars, votes each, when voting closes, how many bank films to show) are at the top of `app.js`. If you raise `VOTES_EACH` above 3 or `BALLOT_SIZE` above 8, raise the matching numbers in `firestore.rules` too and re-publish them.
- **Voting is trust-based between devices.** Each browser gets its own 3 votes, so a member could vote again from another browser or a private window. That's fine for a group of friends.
- **Rescheduling** moves the closing time with it, so moving a night later reopens voting.
- Names are typed in and remembered per browser. They aren't verified.
- Free Firebase limits (50k reads and 20k writes a day) are far more than a club needs.

## Ideas for later
- Film posters and details from the TMDB API (needs a free API key)
- Ranked-choice voting (3/2/1 points instead of 3 equal votes)
- A veto: each person can block one film per round
- A "can't make it" RSVP for each night
