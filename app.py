import sys
import os
import re
import sqlite3
import subprocess
import atexit
import signal
import time
from functools import wraps
from pathlib import Path

from flask import (
    Flask, g, jsonify, redirect, render_template,
    request, session, url_for
)
from werkzeug.security import check_password_hash, generate_password_hash

# =========================================================
# PATHS AND CONFIGURATION
# =========================================================

BASE_DIR = Path(__file__).resolve().parent
INSTANCE_DIR = BASE_DIR / "instance"
INSTANCE_DIR.mkdir(exist_ok=True)

DB_PATH = INSTANCE_DIR / "bloom.db"

# Local desktop voice engine
VOICE_DIR = BASE_DIR / "desktop_companion"
VOICE_SCRIPT = VOICE_DIR / "bloom_global_dictation.py"

app = Flask(__name__)

app.config.update(
    SECRET_KEY=os.environ.get(
        "BLOOM_SECRET_KEY",
        "dev-only-change-this-secret"
    ),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

# =========================================================
# DATABASE
# =========================================================

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()

    db.executescript("""
                     CREATE TABLE IF NOT EXISTS users (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          name TEXT NOT NULL,
                                                          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                                                          password_hash TEXT NOT NULL,
                                                          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                     );

                     CREATE TABLE IF NOT EXISTS documents (
                                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                              user_id INTEGER NOT NULL,
                                                              title TEXT NOT NULL DEFAULT 'Untitled Document',
                                                              content TEXT NOT NULL DEFAULT '',
                                                              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                                              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                                              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                         );

                     CREATE TABLE IF NOT EXISTS drafts (
                                                           user_id INTEGER PRIMARY KEY,
                                                           content TEXT NOT NULL DEFAULT '',
                                                           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                                           FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                         );
                     """)

    db.commit()


with app.app_context():
    init_db()


# =========================================================
# USER AUTHENTICATION
# =========================================================

def current_user():
    uid = session.get("user_id")

    if not uid:
        return None

    return get_db().execute(
        "SELECT id, name, email FROM users WHERE id=?",
        (uid,)
    ).fetchone()


def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({
                    "error": "Please sign in again."
                }), 401

            return redirect(url_for("login"))

        return fn(*args, **kwargs)

    return wrapped


def doc_to_dict(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# =========================================================
# PAGES
# =========================================================

@app.route("/")
def index():
    if current_user():
        return redirect(url_for("workspace"))

    return render_template("landing.html")


@app.route("/register", methods=["GET", "POST"])
def register():
    error = ""

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        if len(name) < 2:
            error = "Please enter your name."

        elif not re.fullmatch(
                r"[^@\s]+@[^@\s]+\.[^@\s]+", email
        ):
            error = "Enter a valid email address."

        elif len(password) < 10:
            error = "Use a password with at least 10 characters."

        elif password != confirm:
            error = "Passwords do not match."

        else:
            try:
                db = get_db()

                cur = db.execute(
                    """
                    INSERT INTO users(name, email, password_hash)
                    VALUES (?, ?, ?)
                    """,
                    (
                        name,
                        email,
                        generate_password_hash(password),
                    ),
                )

                db.execute(
                    "INSERT INTO drafts(user_id, content) VALUES(?, '')",
                    (cur.lastrowid,),
                )

                db.commit()

                session.clear()
                session["user_id"] = cur.lastrowid

                return redirect(url_for("workspace"))

            except sqlite3.IntegrityError:
                error = "An account with this email already exists."

    return render_template(
        "auth.html",
        mode="register",
        error=error,
    )


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        row = get_db().execute(
            "SELECT * FROM users WHERE email=?",
            (email,),
        ).fetchone()

        if row and check_password_hash(
                row["password_hash"], password
        ):
            session.clear()
            session["user_id"] = row["id"]

            return redirect(url_for("workspace"))

        error = "Email or password is incorrect."

    return render_template(
        "auth.html",
        mode="login",
        error=error,
    )


@app.post("/logout")
@login_required
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/app")
@login_required
def workspace():
    return render_template(
        "index.html",
        user=current_user(),
    )


@app.route("/privacy")
def privacy():
    return render_template(
        "legal.html",
        page="Privacy Policy",
    )


@app.route("/terms")
def terms():
    return render_template(
        "legal.html",
        page="Terms of Use",
    )


# =========================================================
# DOCUMENT API
# =========================================================

@app.get("/api/documents")
@login_required
def list_documents():
    rows = get_db().execute(
        """
        SELECT * FROM documents
        WHERE user_id=?
        ORDER BY updated_at DESC, id DESC
        """,
        (session["user_id"],),
    ).fetchall()

    return jsonify([doc_to_dict(row) for row in rows])


@app.post("/api/documents")
@login_required
def create_document():
    data = request.get_json(silent=True) or {}

    title = str(
        data.get("title") or "Untitled Document"
    ).strip()[:120]

    content = str(data.get("content") or "")[:100000]

    db = get_db()

    cur = db.execute(
        """
        INSERT INTO documents(user_id, title, content)
        VALUES (?, ?, ?)
        """,
        (
            session["user_id"],
            title or "Untitled Document",
            content,
        ),
    )

    db.commit()

    row = db.execute(
        """
        SELECT * FROM documents
        WHERE id=? AND user_id=?
        """,
        (cur.lastrowid, session["user_id"]),
    ).fetchone()

    return jsonify(doc_to_dict(row)), 201


@app.route(
    "/api/documents/<int:doc_id>",
    methods=["GET", "PUT", "DELETE"],
)
@login_required
def document_detail(doc_id):
    db = get_db()

    row = db.execute(
        """
        SELECT * FROM documents
        WHERE id=? AND user_id=?
        """,
        (doc_id, session["user_id"]),
    ).fetchone()

    if not row:
        return jsonify({
            "error": "Document not found."
        }), 404

    if request.method == "GET":
        return jsonify(doc_to_dict(row))

    if request.method == "PUT":
        data = request.get_json(silent=True) or {}

        title = str(
            data.get("title", row["title"])
        ).strip()[:120] or "Untitled Document"

        content = str(
            data.get("content", row["content"])
        )[:100000]

        db.execute(
            """
            UPDATE documents
            SET title=?, content=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND user_id=?
            """,
            (
                title,
                content,
                doc_id,
                session["user_id"],
            ),
        )

        db.commit()

        updated = db.execute(
            """
            SELECT * FROM documents
            WHERE id=? AND user_id=?
            """,
            (doc_id, session["user_id"]),
        ).fetchone()

        return jsonify(doc_to_dict(updated))

    db.execute(
        "DELETE FROM documents WHERE id=? AND user_id=?",
        (doc_id, session["user_id"]),
    )

    db.commit()

    return jsonify({"ok": True})


# =========================================================
# DRAFT API
# =========================================================

@app.get("/api/draft")
@login_required
def get_draft():
    row = get_db().execute(
        "SELECT content FROM drafts WHERE user_id=?",
        (session["user_id"],),
    ).fetchone()

    return jsonify({
        "content": row["content"] if row else ""
    })


@app.put("/api/draft")
@login_required
def put_draft():
    data = request.get_json(silent=True) or {}

    content = str(data.get("content") or "")[:100000]

    db = get_db()

    db.execute(
        """
        INSERT INTO drafts(user_id, content, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
            content=excluded.content,
                                        updated_at=CURRENT_TIMESTAMP
        """,
        (session["user_id"], content),
    )

    db.commit()

    return jsonify({"ok": True})


# =========================================================
# HEALTH AND VOICE STATUS
# =========================================================

@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "app": "Bloom Voice",
    })


# Process handle for the local voice engine.
voice_process = None


def start_voice_engine():
    """
    Start the local desktop voice companion when app.py runs.

    Set BLOOM_AUTO_START_VOICE=0 to disable automatic startup.
    """

    global voice_process

    if os.environ.get("BLOOM_AUTO_START_VOICE", "1") == "0":
        print("Automatic voice startup is disabled.")
        return

    if voice_process is not None and voice_process.poll() is None:
        print("Voice engine is already running.")
        return

    if not VOICE_SCRIPT.is_file():
        print(f"Voice engine script not found: {VOICE_SCRIPT}")
        print("The web app will continue without the voice engine.")
        return

    try:
        # Use the same Python interpreter/environment as app.py.
        voice_process = subprocess.Popen(
            [sys.executable, str(VOICE_SCRIPT)],
            cwd=str(VOICE_DIR),
        )

        # Give the child process a moment to detect immediate failures.
        time.sleep(0.5)

        if voice_process.poll() is not None:
            print(
                "Voice engine exited during startup. "
                "Check its dependencies and model paths."
            )
            voice_process = None
            return

        print(
            f"Bloom voice engine started "
            f"(PID {voice_process.pid})."
        )

    except OSError as exc:
        voice_process = None
        print(f"Could not start the voice engine: {exc}")


def stop_voice_engine():
    """Stop the child voice process when app.py exits."""

    global voice_process

    process = voice_process

    if process is None or process.poll() is not None:
        return

    print("Stopping Bloom voice engine...")

    process.terminate()

    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

    voice_process = None


atexit.register(stop_voice_engine)


# =========================================================
# START EVERYTHING
# =========================================================

if __name__ == "__main__":
    # Prevent Flask's development reloader from starting a second
    # voice-engine process.
    start_voice_engine()

    try:
        app.run(
            host=os.environ.get("BLOOM_HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5000")),
            debug=False,
            use_reloader=False,
        )
    finally:
        stop_voice_engine()
