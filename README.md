# Table Booker

Books a table on the ServiceNow portal every **Tuesday and Thursday**, for the date
**14 days ahead**. Runs on GitHub's servers, so your computer can be off.

At login, Okta sends a **push to your phone**. **Tap Approve** and the booking finishes.
The login is saved between runs, so some runs need no push at all.

---

## One-time setup (about 10 minutes)

### 1. Copy this project into your own GitHub account
1. Create a free account at github.com if you don't have one.
2. Create a **new private repository** (e.g. `table-booker`).
3. Upload every file from this folder, including the `.github` folder.
   (On the repo page: **Add file → Upload files**, then drag the folder contents in.)

### 2. Add your login as Secrets (encrypted, nobody can read them back)
Repo → **Settings → Secrets and variables → Actions → Secrets tab → New repository secret**

| Name | Value |
|---|---|
| `OKTA_USERNAME` | your Okta username / work email |
| `OKTA_PASSWORD` | your Okta password |

### 3. Add your booking preferences as Variables
Same page → **Variables tab → New repository variable**

| Name | Example | Meaning |
|---|---|---|
| `FORM_FIELDS` | `[{"label":"Building","value":"100 Adelaide"},{"label":"Date","value":"{date}"},{"label":"Start","value":"9:00 AM"},{"label":"End","value":"5:00 PM"}]` | Form fields by their label on the page. `{date}` is replaced with the booking date. |
| `PREFERRED_SPACES` | `T-12-04,T-12-05` | Tables you'd like, in order. Falls back to the first available one. |
| `BOOK_AT` | `07:00` | Time (Toronto) the booking window opens. Default 07:00. |
| `DATE_FORMAT` | `YYYY-MM-DD` | How the date must be typed into the form (`YYYY`, `MM`, `MMM`, `DD`). |
| `RESERVATION_URL` | `https://tmx.service-now.com/sp?id=...` | Optional: direct link to "Make a reservation" (copy from your browser). Makes it more reliable. |

Optional: `DAYS_AHEAD` (14), `BOOK_DAYS` (`Tue,Thu`), `TIME_ZONE` (`America/Toronto`),
`SUCCESS_TEXT` (text shown after a successful booking).

### 4. Test it
1. Repo → **Actions** tab → enable workflows if asked.
2. Click **Book table → Run workflow**. Leave **"Test only"** ticked.
3. Approve the Okta push on your phone.
4. When it finishes, open the run and download **screenshots** at the bottom.
   It stops just before reserving, so you can check it picked the right things.
5. When the screenshots look right, run it once with "Test only" unticked
   (optionally with a `target_date`) to make a real booking.

After that it runs automatically. GitHub emails you if a run fails.

---

## Changing the time
The schedule in `.github/workflows/book.yml` must start ~15 minutes before `BOOK_AT`,
written in UTC for both summer and winter time. For `BOOK_AT` = `HH:MM` Toronto time,
use minute `MM - 15` and hours `HH+4` and `HH+5`:

| BOOK_AT | cron line |
|---|---|
| 07:00 | `'45 10,11 * * 2,4'` |
| 08:00 | `'45 11,12 * * 2,4'` |
| 00:00 (midnight) | `'45 3,4 * * 2,4'` |

GitHub can start scheduled runs a few minutes late; the script logs in early and
waits for the exact time, so starting 15 minutes early covers that.

## Sharing with colleagues
Give them this folder (or make your repo a template). Each person creates their own
private repo and adds **their own** secrets and variables. Never share your password.

## If something breaks
Download the screenshots from the failed run and check `error.png`. Most issues are a
field label in `FORM_FIELDS` that doesn't match the page text exactly.
