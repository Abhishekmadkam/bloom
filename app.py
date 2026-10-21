import os
import re
import sqlite3
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
INSTANCE_DIR = BASE_DIR / "instance"
INSTANCE_DIR.mkdir(exist_ok=True)
DB_PATH = INSTANCE_DIR / "bloom.db"

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("BLOOM_SECRET_KEY", "dev-only-change-this-secret"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

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

def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return get_db().execute("SELECT id, name, email FROM users WHERE id=?", (uid,)).fetchone()

def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"error": "Please sign in again."}), 401
            return redirect(url_for("login"))
        return fn(*args, **kwargs)
    return wrapped

def doc_to_dict(row):
    return {
        "id": row["id"], "title": row["title"], "content": row["content"],
        "created_at": row["created_at"], "updated_at": row["updated_at"]
    }

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
        elif not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            error = "Enter a valid email address."
        elif len(password) < 10:
            error = "Use a password with at least 10 characters."
        elif password != confirm:
            error = "Passwords do not match."
        else:
            try:
                db = get_db()
                cur = db.execute(
                    "INSERT INTO users(name,email,password_hash) VALUES(?,?,?)",
                    (name, email, generate_password_hash(password))
                )
                db.execute("INSERT INTO drafts(user_id,content) VALUES(?, '')", (cur.lastrowid,))
                db.commit()
                session.clear()
                session["user_id"] = cur.lastrowid
                return redirect(url_for("workspace"))
            except sqlite3.IntegrityError:
                error = "An account with this email already exists."
    return render_template("auth.html", mode="register", error=error)

@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        row = get_db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if row and check_password_hash(row["password_hash"], password):
            session.clear()
            session["user_id"] = row["id"]
            return redirect(url_for("workspace"))
        error = "Email or password is incorrect."
    return render_template("auth.html", mode="login", error=error)

@app.post("/logout")
@login_required
def logout():
    session.clear()
    return redirect(url_for("index"))

@app.route("/app")
@login_required
def workspace():
    return render_template("index.html", user=current_user())

@app.route("/privacy")
def privacy():
    return render_template("legal.html", page="Privacy Policy")

@app.route("/terms")
def terms():
    return render_template("legal.html", page="Terms of Use")

@app.get("/api/documents")
@login_required
def list_documents():
    rows = get_db().execute(
        "SELECT * FROM documents WHERE user_id=? ORDER BY updated_at DESC, id DESC",
        (session["user_id"],)
    ).fetchall()
    return jsonify([doc_to_dict(row) for row in rows])

@app.post("/api/documents")
@login_required
def create_document():
    data = request.get_json(silent=True) or {}
    title = str(data.get("title") or "Untitled Document").strip()[:120]
    content = str(data.get("content") or "")[:100000]
    db = get_db()
    cur = db.execute(
        "INSERT INTO documents(user_id,title,content) VALUES(?,?,?)",
        (session["user_id"], title or "Untitled Document", content)
    )
    db.commit()
    row = db.execute("SELECT * FROM documents WHERE id=? AND user_id=?",
                     (cur.lastrowid, session["user_id"])).fetchone()
    return jsonify(doc_to_dict(row)), 201

@app.route("/api/documents/<int:doc_id>", methods=["GET", "PUT", "DELETE"])
@login_required
def document_detail(doc_id):
    db = get_db()
    row = db.execute("SELECT * FROM documents WHERE id=? AND user_id=?",
                     (doc_id, session["user_id"])).fetchone()
    if not row:
        return jsonify({"error": "Document not found."}), 404
    if request.method == "GET":
        return jsonify(doc_to_dict(row))
    if request.method == "PUT":
        data = request.get_json(silent=True) or {}
        title = str(data.get("title", row["title"])).strip()[:120] or "Untitled Document"
        content = str(data.get("content", row["content"]))[:100000]
        db.execute("UPDATE documents SET title=?,content=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?",
                   (title, content, doc_id, session["user_id"]))
        db.commit()
        updated = db.execute("SELECT * FROM documents WHERE id=? AND user_id=?",
                             (doc_id, session["user_id"])).fetchone()
        return jsonify(doc_to_dict(updated))
    db.execute("DELETE FROM documents WHERE id=? AND user_id=?", (doc_id, session["user_id"]))
    db.commit()
    return jsonify({"ok": True})

@app.get("/api/draft")
@login_required
def get_draft():
    row = get_db().execute("SELECT content FROM drafts WHERE user_id=?", (session["user_id"],)).fetchone()
    return jsonify({"content": row["content"] if row else ""})

@app.put("/api/draft")
@login_required
def put_draft():
    data = request.get_json(silent=True) or {}
    content = str(data.get("content") or "")[:100000]
    db = get_db()
    db.execute("""
        INSERT INTO drafts(user_id,content,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP
    """, (session["user_id"], content))
    db.commit()
    return jsonify({"ok": True})

@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "app": "Bloom AI"})

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")
