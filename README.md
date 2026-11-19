# Desire: adults-only dating site on Firebase (free Spark plan)

Stack: static site (GitHub Pages or Firebase Hosting) + Firebase Auth (email/password, built-in email verification)
+ Firestore with security rules. **No Cloud Functions and no billing account needed.**

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
2. **Authentication > Sign-in method**: enable **Email/Password** and **Anonymous** (Anonymous powers guest chat).
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
| Chat without registering | `#/guest`: nickname + date of birth (18+) + Terms, no email. Guests get the **public lobby only**: no profiles, no private messages |
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

## Guest chat (no registration): how it's limited
Email stays mandatory for profiles and private (1-to-1) messages, the only exception is the public lobby. Guests:
- must enter a date of birth showing 18+ and accept the Terms (including moderation); stored on a `guests` record;
- can post at most one message every 3 seconds (enforced by the rules), max 500 characters;
- can report any lobby message; admins can delete messages and ban guests (all recorded in the audit log).

Honest limitations: a guest has no email, so a banned guest can return by clearing browser data and starting a new guest session. Anonymous accounts are also easy to create in bulk. Enable **App Check** (free), watch the lobby, and if abuse grows, make the lobby members-only by removing `guestOk()` from `canLobby()` in `firestore.rules`. Lobby messages are kept until you delete them; prune old ones occasionally to stay inside the free quota.
