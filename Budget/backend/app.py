"""Budget tracker API.

Flask application served by Waitress. Stores everything in one SQLite file.
It also serves the static frontend, so a single process runs the whole app
locally. In production the frontend can live on a static host (Netlify) that
proxies /api/* to this server.
"""

import hmac
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_from_directory, session

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"


def load_env_file(path):
    """Read KEY=VALUE lines from backend/.env. Real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


load_env_file(BASE_DIR / ".env")

DB_PATH = Path(os.environ.get("BUDGET_DB", BASE_DIR / "budget.db"))

# The password lock is on whenever BUDGET_PASSWORD is set.
PASSWORD = os.environ.get("BUDGET_PASSWORD", "")
MAX_FAILED_LOGINS = 5
FAILED_LOGIN_WINDOW = 300  # seconds
OPEN_PATHS = {"/api/health", "/api/login", "/api/logout"}

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
KINDS = {"card", "savings"}
MAX_AMOUNT = 1e12

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('card', 'savings')),
    name       TEXT NOT NULL,
    bank       TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS entries (
    month      TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    amount     REAL NOT NULL,
    PRIMARY KEY (month, account_id)
);
CREATE TABLE IF NOT EXISTS expenses (
    id         TEXT PRIMARY KEY,
    date       TEXT NOT NULL,
    amount     REAL NOT NULL,
    category   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses(date);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

app = Flask(__name__, static_folder=None)
app.config.update(
    SESSION_COOKIE_NAME="budget_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Hosting platforms set PORT and serve over HTTPS; plain http://localhost does not.
    SESSION_COOKIE_SECURE=os.environ.get("BUDGET_COOKIE_SECURE", "1" if "PORT" in os.environ else "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


# ---------------------------------------------------------------- database

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def rows(sql, params=()):
    return [dict(r) for r in db().execute(sql, params).fetchall()]


def session_secret():
    """Key that signs the login cookie. Generated once and kept in the database."""
    if os.environ.get("BUDGET_SECRET"):
        return os.environ["BUDGET_SECRET"]
    conn = connect()
    try:
        conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('secret', ?)", (secrets.token_hex(32),))
        conn.commit()
        return conn.execute("SELECT value FROM meta WHERE key = 'secret'").fetchone()["value"]
    finally:
        conn.close()


# ------------------------------------------------------------ password lock

failed_logins = {}  # client address -> times of recent wrong passwords
failed_logins_lock = threading.Lock()


def password_fingerprint():
    """Ties a login to the current password, so changing it signs everyone out."""
    return hmac.new(app.secret_key.encode(), PASSWORD.encode(), "sha256").hexdigest()


def unlocked():
    if not PASSWORD:
        return True
    token = session.get("auth")
    return isinstance(token, str) and hmac.compare_digest(token, password_fingerprint())


def seconds_until_retry(address, record_failure=False):
    """How long this client must wait before trying another password (0 = go ahead)."""
    now = time.monotonic()
    with failed_logins_lock:
        recent = [t for t in failed_logins.get(address, []) if now - t < FAILED_LOGIN_WINDOW]
        if record_failure:
            recent.append(now)
        if recent:
            failed_logins[address] = recent
        else:
            failed_logins.pop(address, None)
        if len(recent) >= MAX_FAILED_LOGINS:
            return FAILED_LOGIN_WINDOW - (now - recent[-MAX_FAILED_LOGINS])
    return 0


# -------------------------------------------------------------- validation

class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Send a JSON object.")
    return data


def clean_text(value, field, required=False, max_len=60):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(f"{field} must be text.")
    value = value.strip()
    if required and not value:
        raise ApiError(f"{field} is required.")
    if len(value) > max_len:
        raise ApiError(f"{field} is too long (max {max_len} characters).")
    return value


def clean_amount(value, field="amount"):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(f"{field} must be a number.")
    if not math.isfinite(value) or value < 0 or value > MAX_AMOUNT:
        raise ApiError(f"{field} must be between 0 and {MAX_AMOUNT:.0f}.")
    return round(float(value), 2)


def clean_month(value):
    if not isinstance(value, str) or not MONTH_RE.match(value):
        raise ApiError("Month must look like 2026-11.")
    return value


def clean_date(value):
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        raise ApiError("date must look like 2026-11-14.") from None


def clean_id(value, field="id"):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise ApiError(f"{field} is not a valid id.")
    return value


def clean_account(data):
    kind = data.get("kind")
    if kind not in KINDS:
        raise ApiError("kind must be 'card' or 'savings'.")
    return {
        "kind": kind,
        "name": clean_text(data.get("name"), "name", required=True, max_len=40),
        "bank": clean_text(data.get("bank"), "bank", max_len=40),
        "color": clean_text(data.get("color"), "color", max_len=20),
    }


def clean_expense(data, known_accounts):
    account_id = data.get("account_id") or None
    if account_id is not None and account_id not in known_accounts:
        account_id = None
    amount = clean_amount(data.get("amount"))
    if amount <= 0:
        raise ApiError("amount must be greater than zero.")
    return {
        "date": clean_date(data.get("date")),
        "amount": amount,
        "category": clean_text(data.get("category"), "category", required=True, max_len=30),
        "note": clean_text(data.get("note"), "note", max_len=120),
        "account_id": account_id,
    }


def account_ids():
    return {r["id"] for r in db().execute("SELECT id FROM accounts")}


# ---------------------------------------------------------------- handlers

@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=str(err)), err.status


@app.errorhandler(404)
def handle_404(_err):
    if request.path.startswith("/api/"):
        return jsonify(error="Not found."), 404
    return "Not found", 404


@app.errorhandler(405)
def handle_405(_err):
    return jsonify(error="Method not allowed."), 405


@app.errorhandler(500)
def handle_500(_err):
    return jsonify(error="Something went wrong on the server."), 500


@app.after_request
def no_cache_api(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------- api

@app.before_request
def require_unlock():
    if request.path.startswith("/api/") and request.path not in OPEN_PATHS and not unlocked():
        return jsonify(error="Locked. Enter the password to continue.", locked=True), 401
    return None


@app.get("/api/health")
def health():
    return jsonify(ok=True, auth=bool(PASSWORD), locked=not unlocked())


@app.post("/api/login")
def login():
    if not PASSWORD:
        return jsonify(ok=True)
    address = request.remote_addr or "unknown"
    wait = seconds_until_retry(address)
    if wait > 0:
        raise ApiError(f"Too many wrong passwords. Try again in {math.ceil(wait / 60)} min.", 429)
    supplied = body().get("password")
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), PASSWORD.encode()):
        seconds_until_retry(address, record_failure=True)
        raise ApiError("Wrong password.", 401)
    with failed_logins_lock:
        failed_logins.pop(address, None)
    session.clear()
    session.permanent = True
    session["auth"] = password_fingerprint()
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


def all_data():
    return {
        "accounts": rows("SELECT id, kind, name, bank, color FROM accounts ORDER BY created_at, rowid"),
        "entries": rows("SELECT month, account_id, amount FROM entries ORDER BY month"),
        "expenses": rows(
            "SELECT id, date, amount, category, note, account_id FROM expenses "
            "ORDER BY date DESC, created_at DESC, rowid DESC"
        ),
    }


@app.get("/api/data")
def get_data():
    return jsonify(all_data())


@app.delete("/api/data")
def reset_data():
    conn = db()
    conn.execute("DELETE FROM expenses")
    conn.execute("DELETE FROM entries")
    conn.execute("DELETE FROM accounts")
    conn.commit()
    return jsonify(ok=True)


@app.post("/api/import")
def import_data():
    """Bulk add (or overwrite by id) accounts, monthly entries and expenses."""
    data = body()
    conn = db()
    try:
        for raw in data.get("accounts") or []:
            acc = clean_account(raw)
            conn.execute(
                "INSERT INTO accounts (id, kind, name, bank, color) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, "
                "bank = excluded.bank, color = excluded.color",
                (clean_id(raw.get("id")), acc["kind"], acc["name"], acc["bank"], acc["color"]),
            )
        known = account_ids()
        for raw in data.get("entries") or []:
            if raw.get("account_id") not in known:
                raise ApiError("An entry points at an account that does not exist.")
            conn.execute(
                "INSERT OR REPLACE INTO entries (month, account_id, amount) VALUES (?, ?, ?)",
                (clean_month(raw.get("month")), raw["account_id"], clean_amount(raw.get("amount"))),
            )
        for raw in data.get("expenses") or []:
            exp = clean_expense(raw, known)
            conn.execute(
                "INSERT OR REPLACE INTO expenses (id, date, amount, category, note, account_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (clean_id(raw.get("id")), exp["date"], exp["amount"], exp["category"],
                 exp["note"], exp["account_id"]),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return jsonify(all_data())


@app.post("/api/accounts")
def create_account():
    acc = clean_account(body())
    acc["id"] = uuid.uuid4().hex
    conn = db()
    conn.execute(
        "INSERT INTO accounts (id, kind, name, bank, color) VALUES (:id, :kind, :name, :bank, :color)",
        acc,
    )
    conn.commit()
    return jsonify(acc), 201


@app.put("/api/accounts/<account_id>")
def update_account(account_id):
    acc = clean_account(body())
    conn = db()
    cur = conn.execute(
        "UPDATE accounts SET kind = ?, name = ?, bank = ?, color = ? WHERE id = ?",
        (acc["kind"], acc["name"], acc["bank"], acc["color"], account_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        raise ApiError("Account not found.", 404)
    acc["id"] = account_id
    return jsonify(acc)


@app.delete("/api/accounts/<account_id>")
def delete_account(account_id):
    conn = db()
    cur = conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    conn.commit()
    if cur.rowcount == 0:
        raise ApiError("Account not found.", 404)
    return jsonify(ok=True)


@app.put("/api/months/<month>")
def save_month(month):
    """Upsert the amounts for one month. An amount of null clears that entry."""
    month = clean_month(month)
    entries = body().get("entries")
    if not isinstance(entries, list):
        raise ApiError("entries must be a list.")
    known = account_ids()
    conn = db()
    try:
        for item in entries:
            if not isinstance(item, dict) or item.get("account_id") not in known:
                raise ApiError("Unknown account in entries.")
            if item.get("amount") is None:
                conn.execute(
                    "DELETE FROM entries WHERE month = ? AND account_id = ?",
                    (month, item["account_id"]),
                )
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO entries (month, account_id, amount) VALUES (?, ?, ?)",
                    (month, item["account_id"], clean_amount(item["amount"])),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return jsonify(ok=True)


@app.post("/api/expenses")
def create_expense():
    exp = clean_expense(body(), account_ids())
    exp["id"] = uuid.uuid4().hex
    conn = db()
    conn.execute(
        "INSERT INTO expenses (id, date, amount, category, note, account_id) "
        "VALUES (:id, :date, :amount, :category, :note, :account_id)",
        exp,
    )
    conn.commit()
    return jsonify(exp), 201


@app.delete("/api/expenses/<expense_id>")
def delete_expense(expense_id):
    conn = db()
    cur = conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    conn.commit()
    if cur.rowcount == 0:
        raise ApiError("Expense not found.", 404)
    return jsonify(ok=True)


# ---------------------------------------------------------------- frontend

@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        abort(404)
    return send_from_directory(FRONTEND_DIR, path)


init_db()
app.secret_key = session_secret()

if __name__ == "__main__":
    from waitress import serve

    if not PASSWORD:
        print("Password lock is OFF. Set BUDGET_PASSWORD (see backend/.env.example) before going online.")
    elif len(PASSWORD) < 8:
        print("Warning: BUDGET_PASSWORD is shorter than 8 characters.")

    # Hosting platforms set PORT and expect the app to listen on all interfaces.
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    print(f"Budget tracker running at http://{'localhost' if host == '127.0.0.1' else host}:{port}")
    serve(app, host=host, port=port, threads=8)
