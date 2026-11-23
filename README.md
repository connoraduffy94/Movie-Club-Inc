# 🎬 Movie Club

A small website for our movie club:
- **Suggest films** for the shortlist
- **Vote** on the shortlist (one vote per film per person; click again to take it back)
- **See the next movie night**: date, place, film, a countdown and an "Add to Google Calendar" link
- **Mark films as watched**, which keeps a history
- **Keeps the shortlist tidy**: shows the top 10 (with "Show all"), puts films with no votes for 2+ months into a collapsed "Gathering dust" section, and has a **Reset votes** button to start a fresh round

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
5. **Project settings (⚙️) → General → Your apps → Web (`</>`)**: register an app (no hosting needed). Copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js).

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
| `app.js` | Rendering, forms, voting, countdown |
| `store.js` | Data layer: Firestore when configured, browser-only demo otherwise |
| `firebase-config.js` | Your Firebase project settings |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

**Data in Firestore**
- `movies/{id}`: `title, year, runtime, link, pitch, submittedBy, submittedByUid, votes[], status ('pending'|'watched'), createdAt, watchedAt, roundStartedAt`
- `meta/nextNight`: `datetime (ISO), location, notes, movieId, movieTitle, updatedBy, updatedAt`

**What the rules enforce**
- Anyone with the link can read.
- Each browser can add or remove **only its own vote**.
- Only the person who suggested a film can delete it.
- Field sizes are capped. Anyone can set the movie night, mark a film as watched, or reset all votes.

## Good to know
- **It's trust-based.** Anyone with the link can vote, and someone could vote again from a different browser or a private window. That's fine for a group of friends. Keep the link within the club.
- **Reset votes** clears everyone's votes on the whole shortlist (it asks first). The films stay. Agree as a club when to use it, e.g. after each movie night.
- To change "top 10" or the 2-month cut-off, edit `TOP_N` and `DUSTY_AFTER` at the top of `app.js`.
- Names are typed in and remembered per browser. They aren't verified.
- Free Firebase limits (50k reads and 20k writes a day) are far more than a club needs.

## Ideas for later
- Film posters and details from the TMDB API (needs a free API key)
- Ranked-choice voting
- A "can't make it" RSVP for each night
