Bloom — Voice and Documents
This project keeps the existing Flask login, document management, settings and responsive UI, with a streamlined voice-and-documents workspace. Browser speech recognition and browser text-to-speech are not used for voice processing.

Run the web app (Windows)
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
$env:BLOOM_SECRET_KEY = py -c "import secrets; print(secrets.token_hex(32))"
py app.py
Open http://127.0.0.1:5000.

Offline Windows voice module
The desktop_companion folder contains a local Vosk speech-to-text companion and local pyttsx3 text-to-speech.

Install Python 3.10+.
Download a compatible Vosk model from https://alphacephei.com/vosk/models and extract it into desktop_companion/models/vosk-model/, or set BLOOM_VOSK_MODEL to the extracted model folder.
In PowerShell, cd desktop_companion, then run py -m pip install -r requirements.txt.
Run py bloom_global_dictation.py.
Focus a text field in any app and press Ctrl+Alt+Space to start/stop offline dictation. Copy text and press Ctrl+Alt+R to read it aloud using a voice installed on Windows. Ctrl+Alt+Q quits.
Accuracy notes
Speech is inserted only from finalized Vosk segments; interim hypotheses are never typed. A short duplicate-segment guard prevents immediate repeated finalized segments.
Accuracy depends on model/language, microphone, noise, accent and speaking pace. No speech engine can guarantee perfect transcription. Use a model matching your language and test with your microphone.
The Vosk model is not bundled because model downloads are large. Voice module will not start until you install one.
The web microphone button explains how to use the local companion; it does not invoke browser speech recognition.
TTS uses installed local system voices. Available languages and naturalness depend on Windows voices installed.
Security
This is a local starter, not production-hardened. Do not expose the Flask development server publicly. Set a strong secret key and add CSRF protection, rate limiting, secure deployment configuration and backups before public hosting.
