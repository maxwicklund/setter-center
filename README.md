# RetireWell Setter Center

A live, password-protected dashboard for the appointment-setting floor. Seven tabs: Floor, Dials & Activity, Appointments & Show Quality, Setter Deep Dive, Speed to Lead, Goals & Leaderboard, Data Health & Definitions. Add `?selftest=1` to the URL for the acceptance self-test.

## How it works

```
Google Sheets (private)  →  Apps Script web app (/exec)  →  this static page (GitHub Pages)
   four spreadsheets           runs as the owner, checks          ships with zero data; asks for
   nobody else can open        the team password, returns         the team password, then fetches
                               counts only                        the counts and draws everything
```

- **The page ships with no data.** Anyone with only the site URL gets HTML, CSS, JavaScript and the endpoint URL, and nothing else.
- **The team password is the endpoint token.** The page POSTs it; the endpoint answers with data only when it matches.
- **Only aggregates leave Google.** Every array in the payload is a count keyed by date and/or setter. No appointment, lead or prospect record, no notes, no pay data. A payload guard on the server refuses to send anything containing forbidden words, a `$`, an appointment ID or a departed setter's name.
- **No third-party code.** Every chart is hand-drawn SVG/CSS; nothing loads from a CDN. A Content-Security-Policy restricts network calls to Google's Apps Script hosts.

## What is in this repo, and what never is

| Path | What |
|---|---|
| `index.html`, `config.js`, `css/`, `js/` | The page. `config.js` holds the endpoint URL (public by design), the 60-dials target and the refresh interval. |
| `apps-script/Code.gs` | The endpoint's logic. No names, IDs or secrets. |
| `apps-script/Config.example.gs` | Fake stand-in for the real config, used by the tests. |
| `tests/` | Runs `Code.gs` and the self-test against **fake** sheets with made-up names. |

**Never committed** (`.gitignore` enforces the first): `apps-script/Config.gs` (spreadsheet IDs, roster, departed list); the team password; anything saved from the live endpoint or a screenshot of the live dashboard; the build prompt.

## Setup checklist

1. **Apps Script project.** script.google.com → New project, signed in with the account that can open all four sheets. Paste `apps-script/Config.gs` and `apps-script/Code.gs` (one file or two; both work). Run `selfCheck` once to authorize and check the reads. *`Config.gs` is private: never commit it.*
2. **Team password.** Run `openssl rand -base64 32` in your own Terminal. In Apps Script: Project Settings → Script Properties → add `DASH_TOKEN` = that value. *Secret: never commit it, never paste it into a chat.*
3. **Deploy.** Deploy → New deployment → Web app. Execute as **Me**. Who has access **Anyone** (not "Anyone with Google Account"). Copy the URL ending in `/exec`. *Not secret: it sits in `config.js` for anyone to read.* Opening it in a browser shows `{"ok":true,…,"configured":true}`.
4. **GitHub.** This repo, public, with GitHub Pages serving the `main` branch root.
5. **Endpoint URL.** `config.js`, **line 5**: `export const ENDPOINT_URL = '…/exec';`. A redeploy with "New version" keeps the same URL, so this only changes if you create a brand-new deployment.
6. **Check.** Open the site in a private/incognito window: you should see only the password box. View source and confirm there are no setter names or numbers anywhere.
7. **Optional, recommended:** Cloudflare Access in front of the site (appendix below).

### Changing the endpoint later

Edit the code in Apps Script, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. Saving alone does not change what `/exec` serves.

### Rotating the team password

Do it whenever someone leaves the team, and every 90 days otherwise. Project Settings → Script Properties → `DASH_TOKEN` → edit → Save. It applies on the next request with no redeploy; everyone is signed out until they get the new one.

**What this password is:** one shared password for the whole team. No identity, no per-person revocation, no sign-in log. Nobody will guess 256 random bits; the real risk is the link and password being forwarded (a screenshot, a group chat, someone who leaves).

## Appendix: Cloudflare Access (a real gate, free)

GitHub Pages can't put a login in front of a public site. Cloudflare Pages + Cloudflare Access can, free for up to 50 users, with per-person sign-in, revoke and a log.

1. **Cloudflare Pages.** dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git → pick this repo. Framework preset: **None**. Build command: *(leave empty)*. Output directory: `/`. Deploy. Every push to `main` redeploys; your git workflow doesn't change. You get a `*.pages.dev` address.
2. **Turn on one-time PIN first.** Zero Trust → Settings → Authentication → Login methods → Add new → **One-time PIN**. New Zero Trust organizations no longer get it automatically.
3. **Protect the project.** Workers & Pages → your project → Settings → **Enable access policy**. This creates an Access application.
4. **Fix the hostname (easy to miss).** Zero Trust → Access → Applications → open the auto-created application → under the public hostname, **remove the wildcard (`*.`) from the subdomain** so it covers `your-project.pages.dev` itself, Save. Then re-enable the policy. Without this only preview deployments are protected.
5. **Who gets in.** Edit the application's policy: Action **Allow**, Include → **Emails** → the team's addresses (or Emails ending in your company domain). Login method: One-time PIN.
6. **Share the `pages.dev` link** instead of the github.io one. You can then make the GitHub repo private (Cloudflare reads it through its GitHub app) so the github.io copy stops being served.

**The limit, plainly:** Access protects the *page*. The Apps Script `/exec` URL is still an unauthenticated public endpoint, and anyone legitimately signed in can open devtools and copy the team password. Access raises the floor; it does not lock the data. The step that does is a Cloudflare Worker that holds the password as a secret and makes the call on the browser's behalf, so the password never reaches a browser. That's a later hardening step.

## Things worth checking by eye

1. Floor (bottom strip), Dials & Activity, Goals (unranked lists) and Data Health (roster): the two names on neither list each appear as their own flagged row.
2. Dials & Activity → Custom → start before 14 Jul 2026: hatched "no data" cells look different from pale "0" cells.
3. Appointments: setters under 10 resolved appointments appear as greyed fractions ("3/5"), unranked.
4. Appointments: Pending (hatched) and Canceled (grey) bars sit apart from the Showed / No Show stack.
5. Data Health: "Answered" appears only in its one line, nowhere else on the site.

## Development

```bash
node --test tests/endpoint.test.mjs tests/selftest.test.mjs
```

Serve the folder on `http://127.0.0.1:<port>` to try the page locally; it talks to the live endpoint, so you'll need the team password.
