# Budget tracker

Track what you owe on every credit card against what you hold in every savings
account, month by month, and log day-to-day spending.

- **Dashboard** (`frontend/index.html`): enter each card's due amount and each
  savings balance for a month. Balance = savings − card dues. Trend chart,
  per-card and per-account breakdowns, dues-to-savings meter, month history.
- **Spending** (`frontend/spending.html`): log expenses by category, see the
  category ranking, day-by-day and six-month charts, and a searchable list.

## Run it on your computer

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python -m pip install -r backend/requirements.txt
```

```bash
.venv\Scripts\python backend/app.py
```

Open http://localhost:8000. Flask (served by Waitress) serves both the pages
and the API, and stores everything in `backend/budget.db` (SQLite).

## Deploying

Netlify only hosts static files; it cannot run a Python server. So there are
two pieces:

1. **Frontend on Netlify.** `netlify.toml` already publishes the `frontend`
   folder. Deployed on its own, the app still works: it notices there is no
   API and keeps your numbers in that browser's local storage (the badge in
   the header says "Saved in this browser").
2. **Backend on a Python host** (Render, Railway, PythonAnywhere, Fly.io, a
   VPS). Start command: `python backend/app.py`. It listens on the `PORT` the
   host provides. Then uncomment the `[[redirects]]` block in `netlify.toml`,
   put your backend URL in it, and redeploy. The header badge switches to
   "Synced to server".

Things to know before putting the backend online:

- **Set a password** (next section). Without one, anyone who has the URL can
  read and change the data.
- **SQLite needs a disk that persists.** Many free tiers wipe the filesystem on
  every restart. Attach a persistent disk and point `BUDGET_DB` at a file on it.

## Password lock

The lock is on whenever the server has a `BUDGET_PASSWORD`.

- **On your computer:** copy `backend/.env.example` to `backend/.env`, put your
  own password in it, and restart the server.
- **On a hosting platform:** add `BUDGET_PASSWORD` as an environment variable
  in its dashboard.

With the lock on, every page shows a password screen and the API refuses all
data requests until the right password is entered. A login lasts 30 days in
that browser; the padlock button in the header locks it again. Five wrong
passwords from one address block further attempts for five minutes. Changing
the password signs every browser out.

The lock protects the data on the server. When the site runs on Netlify with
no backend, the numbers live in the visitor's own browser and there is nothing
on a server to lock.

## Settings

Set these as environment variables, or in `backend/.env`.

| Variable | Default | Purpose |
|---|---|---|
| `BUDGET_PASSWORD` | not set (lock off) | Password that unlocks the app |
| `BUDGET_DB` | `backend/budget.db` | Path of the SQLite file |
| `PORT` | `8000` | Port to listen on |
| `HOST` | `127.0.0.1` (or `0.0.0.0` when `PORT` is set) | Interface to bind |
| `BUDGET_COOKIE_SECURE` | `1` when `PORT` is set, else `0` | Send the login cookie over HTTPS only |
| `BUDGET_SECRET` | generated, kept in the database | Key that signs the login cookie |

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Liveness check; says whether the app is locked |
| POST | `/api/login` | Unlock with `{"password": "..."}` |
| POST | `/api/logout` | Lock again |
| GET | `/api/data` | All accounts, monthly entries and expenses |
| DELETE | `/api/data` | Delete everything |
| POST | `/api/import` | Bulk add accounts, entries and expenses |
| POST | `/api/accounts` | Add a card or savings account |
| PUT / DELETE | `/api/accounts/<id>` | Edit or delete one |
| PUT | `/api/months/<YYYY-MM>` | Save amounts for a month (`null` clears one) |
| POST | `/api/expenses` | Add an expense |
| DELETE | `/api/expenses/<id>` | Delete an expense |
