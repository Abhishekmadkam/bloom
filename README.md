# Bloom AI — Voice Assistant

A mobile-first Flask + SQLite starter app inspired by the supplied Bloom AI UI reference.

## Features
- Responsive Bloom AI UI: onboarding, home, voice workspace, AI assistant, documents, document detail, settings/profile
- Account registration, login and logout
- Per-user SQLite documents and drafts
- Browser speech recognition where supported (Chrome/Edge recommended)
- Basic local text commands: clean, uppercase, lowercase, capitalize, new paragraph, new line
- Search and filter saved documents
- Password hashing and user-owned document access checks

## Run on Windows
```powershell
cd bloom_ai_app
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:BLOOM_SECRET_KEY = python -c "import secrets; print(secrets.token_hex(32))"
python app.py
```
Open http://127.0.0.1:5000

For repeat sessions, set `BLOOM_SECRET_KEY` to a persistent secret. Do not use Flask's development server for public production hosting. Add CSRF protection, rate limiting, HTTPS, email verification and a production WSGI server before deployment.

## AI model note
The interface includes an AI assistant panel and useful local editing commands. Real LLM rewriting/summarization is not connected by default. Add a server-side model/API integration before presenting those actions as AI-powered.
