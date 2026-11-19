# Desire: adults-only, Tinder-style dating site on Firebase (free Spark plan)

Stack: static site (GitHub Pages or Firebase Hosting) + Firebase Auth (email/password, built-in email verification)
+ Firestore with security rules. **No Cloud Functions, no Storage bucket, no billing account needed.**

## What the app does now
| Area | How it works |
|---|---|
| **Home page** | Short landing screen: *Adults only · Real people · You set the pace*, then Create account / Log in / Continue as guest. |
| **Discover** | Tinder-style card deck. Drag a card right to like, left to pass (or use the buttons); tap a card to open the full profile. People who are online are shown first and have a green dot. Blocked, already-liked and recently passed people are hidden. |
| **Matches** | If you like someone who already liked you, it is a match: a conversation opens straight in your inbox, with no request step. |
| **Profile (own)** | **Profile** tab: avatar, name, age, city, job, **Edit profile**, **Preview** (how others see you), "Show me as online" switch, max distance, location sharing, Terms, Log out. |
| **Edit profile** | Up to **4 photos** (add, remove, "make main"), about me, job, school, height, what you're looking for, up to 6 interests. |
| **Other profiles** | Photo gallery (tap left/right), name, age, online dot, distance, job/school, bio, looking for, interests, height, Like / Pass / Message, Block, Report. |
| **Online** | Photo grid of everyone active in the last 7 minutes (heartbeat every 3 minutes; each member can switch it off in Profile). The green dot also shows on cards, profiles, the inbox and chat headers. |
| **Message requests** | A first message to someone you haven't matched with is sent as a **request**. It does **not** appear in their Chats; it shows under **Messages > Requests** (with a badge). Until they accept, the sender can send **2 messages** (guests too), then the composer is locked. The receiver can **Accept**, **Decline** (sender can't send more) or reply (a reply accepts). |
| **Pictures in chat** | Registered members (verified email) can send a picture in any chat, including as one of the two request messages. **Guests cannot send pictures** (the rules enforce this). |
| **Guests** | No email: can see who is online, use Random blind chat and send message requests. They cannot swipe, like, browse everyone or send pictures. |
| **Lobby** | Removed (page, rules and navigation). Old `lobby` / `lobbyState` documents can be deleted in the console. |

### Where photos live (important)
Firebase Storage now needs a paid plan, so photos are **compressed in the browser and stored as small JPEG text inside Firestore**:
`photos/{uid}` holds up to 4 photos (about 600-900 px each, under about 190 KB each) and `users/{uid}.thumb` holds a small 3:4 thumbnail of the main photo used by the swipe deck and lists. Chat pictures are stored in the message (`img`, under about 180 KB). This is fine for launch; if the site grows, move pictures to Cloud Storage / Cloudflare R2 and keep only URLs in Firestore.

### Deploy the update
```bash
firebase deploy --only firestore     # publishes the new rules (required)
```
Then push `public/` to GitHub (or `firebase deploy --only hosting`). Existing accounts and conversations keep working: older conversations without a `status` count as accepted chats. Existing members simply have no photos yet; the Discover page nudges them to add one.

### Free-plan cost notes
Each open tab writes `lastSeen` about 20 times an hour. Swiping costs 1 write per like. A deck load reads up to 150 profiles (thumbnails are about 25 KB each). If you outgrow the free quota, lower the deck `limit(150)` in `pageBrowse` or raise `BEAT_MS` in `app.js`.

---

## Hosting the site on GitHub Pages
The site is plain static files in `public/`, so GitHub Pages works. Firebase still provides login and the database.
1. Create a GitHub repo and push this folder to the `main` branch (the `.gitignore` keeps keys out; double-check that no service-account `.json` key is ever committed).
2. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**. The included workflow (`.github/workflows/pages.yml`) publishes `public/` on every push to `main`.
3. Your site is at `https://<username>.github.io/<repo>/`.
4. **Firebase console > Authentication > Settings > Authorized domains > Add domain**: `<username>.github.io`. Without this, sign-up and email verification will fail.
5. Deploy the security rules, which GitHub does not do (free, no Hosting needed):
   `firebase deploy --only firestore:rules`
6. Recommended: in Google Cloud console > APIs & Services > Credentials, restrict your Web API key to HTTP referrer `https://<username>.github.io/*`.

Notes: the Firebase web config in `public/firebase-config.js` is meant to be public; the security rules are what protect the data. Free GitHub accounts can use Pages only on **public** repos, so your source code will be public. GitHub's Acceptable Use Policy restricts sexually explicit content, so keep the site and profiles non-explicit (or host on Firebase Hosting / Cloudflare Pages instead if you expect adult-oriented content).

## One-time setup (all free)
1. Create a project at https://console.firebase.google.com (stay on the free **Spark** plan; do not add billing).
2. **Authentication > Sign-in method**: enable **Email/Password** and **Anonymous** (Anonymous powers guest sessions).
3. **Firestore Database**: create a database (production mode).
4. **Project settings > General > Your apps**: add a **Web app**, copy its config into `public/firebase-config.js`.
5. Put your project ID in `.firebaserc`.
6. Deploy:
```bash
npm install -g firebase-tools
firebase login
firebase deploy            # hosting + Firestore rules
```
7. Open your site, register an account for yourself and verify the email. Then make it an admin, from your own computer:
   - Firebase console > Project settings > Service accounts > **Generate new private key** (keep this file private, never share or commit it).
   - Then:
```bash
cd scripts && npm install
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node set-admin.js you@example.com
```
Sign out and back in; an **Admin** link appears.

## How the requirements are met
| Requirement | How |
|---|---|
| Basic information form | `#/register`: name, DOB, email, password, gender, looking for, city, bio, 18+ and Terms checkboxes |
| Email mandatory for chat | Firestore rules require a verified email (`email_verified == true`) to read or send any message. Enforced on the server, not just in the UI |
| Chat without registering | `#/guest`: nickname, gender and 18+ date of birth, no email. Guests can use Online, blind chat and message requests only. |
| Male/female matching | Discover shows only members whose gender and preference match yours |
| 18+ | Rules reject profiles under 18 years; DOB and gender can't be edited afterwards |
| You can check messages | Admin > Conversations (see below) |

## Message review (admin), enforced by the rules
Members can read only their own conversations. For an admin, a conversation's messages become readable only if:
1. the account has the `admin` claim,
2. an **audit entry** with a written reason (5+ characters) was written in the same batch, and
3. a **10-minute access grant** for that one conversation exists (the rules refuse a grant without that fresh audit entry).

Audit entries are append-only: nobody can edit or delete them. Conversation lists show only who talked and when, never message text. Members agree to review at sign-up and see a notice in every chat. Anyone with Owner/Editor access to the Firebase project can still read raw data in the console, so keep that list short.

**Banning:** an admin ban sets `banned: true`. Rules then block that member from chatting, browsing, blocking and reporting, and the app signs them out. (Their Auth account isn't disabled, since that needs the paid Admin tooling, but they can't do anything.)

## Free-plan limits (check the current numbers at firebase.google.com/pricing)
Roughly: Firestore 1 GiB storage and 50,000 reads / 20,000 writes per day; Hosting 10 GB storage and about 360 MB/day transfer. That's plenty for launching and testing; if the site grows past it, Firebase simply stops serving until the next day or you choose to upgrade.

## Before going public
- Test the rules in the Firebase Emulator Suite (`firebase emulators:start`); I could not run the emulator in my environment.
- Consider **App Check** (free) and watch for sign-up/message spam.
- Add account deletion and a full Terms/Privacy Policy reviewed by a lawyer (age-verification and data-protection rules such as India's DPDP Act vary by country).
- Customise the verification email template under Authentication > Templates; add a custom domain under Authentication > Settings > Authorized domains.

## Blind chat (Omegle-style random match, opposite gender only)
**Random** in the menu pairs a verified member with an anonymous member of the **opposite gender** who is searching at the same moment. No Cloud Functions are used.

How it works: pressing *Find someone* writes `waiting/{uid}` (gender copied from the profile, refreshed every 20 s). The client queries fresh waiting entries of the opposite gender, picks one at random and, in one Firestore transaction, creates `rooms/{id}` and flips both waiting entries to `matched`. Each side's listener then opens the room. *Next* ends the room and searches again; *Leave* ends it; closing the tab ends it too.

What the rules enforce (not just the UI): both entries must be fresh and still waiting, the two genders must differ, the room must be brand new in the same commit, only the two participants can read or post, and nobody can post after the room has ended. Admin review of a room uses the same audit entry + 10-minute grant as private conversations (**Admin > Blind chats**). Members can report their partner; the report carries the room id.

**After updating:** `firebase deploy --only firestore` (publishes the new rules **and** the new composite index for `waiting`; the index takes a minute or two to build, until then matching shows an error in the browser console with a link).

Limits to know about:
- **Anonymity is front-end deep.** The chat UI hides names, but the partner's user id is in the room document, and member profiles are readable by other members, so a technical user could look the partner up. True anonymity would need Cloud Functions (paid Blaze plan).
- Matching only works while both people have the page open (it is a live queue). With few members online, searches will wait; consider seeding it with a "N people searching" counter later.
- A tab that crashes can leave a stale waiting entry for up to 60 s; the partner just taps *Next*.
- Free-plan cost: about 3 writes/min while searching plus 1 per message. Rooms and messages are kept for moderation, so prune old `rooms` occasionally.
- Gender matching uses the gender on the member's profile (strictly male <-> female), ignoring the "looking for" setting.

## Troubleshooting blind chat
The searching screen now shows a status line. "Setup needed ... index" means run `firebase deploy --only firestore` and wait until **Firestore > Indexes** says *Enabled*. "Setup needed ... rules" means the rules were not published. Test with **two different accounts, one male and one female** (the same account on two devices has the same user id and can never match with itself). Matching measures freshness against your own server timestamp, so a wrong phone clock no longer hides people.

**Update:** matching no longer needs any composite index (it uses two equality filters and checks freshness in the browser), so `firebase deploy --only firestore` only has to publish the rules. If the console still lists the old `waiting` index you can delete it. Abandoned queue entries older than 3 minutes can be tidied by any member in good standing.

## Nearby members and location
In **Profile**, members can tap "Use my location". Only a coarse grid cell (about 5 km, integers `gx`/`gy`) is stored, never exact coordinates; others see a range such as "Within 10 km". The distance limit for Discover is also set in Profile and stored only in the browser.

## Honest limitations
- Guests have no presence record, so they don't appear in Online (they can still see members who are online, subject to the rules' 10-minute window for guest listing).
- Anonymous accounts are cheap to create, so guests can be used for spam. Enable **App Check** and watch reports; the 2-message request limit already stops most mass-messaging from new accounts.
- A user could try to open another browser profile to send more than 2 request messages; the limit is enforced by the Firestore rules per conversation (`reqCount`), but a banned or fresh account can start new conversations. Ban abusers from **Admin**.
- Pictures are not scanned automatically. Review reports, and consider a moderation API before going public.
- I could not run the Firebase Emulator in my environment. Test the new rules with the Emulator Suite or with two real accounts (one male, one female, verified) before launch.
