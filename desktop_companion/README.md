# Bloom Voice Module — Windows (offline)

Local Vosk speech-to-text and local `pyttsx3` speech output. No cloud speech API is used.

## Setup
1. Install Python 3.10+.
2. Download a Vosk model from https://alphacephei.com/vosk/models.
3. Extract it to `desktop_companion/models/vosk-model/` (the folder must contain model files), or set `BLOOM_VOSK_MODEL` to the model folder.
4. In PowerShell, run:
```powershell
py -m pip install -r requirements.txt
py bloom_global_dictation.py
```
5. Focus a text field in the target app and press **Ctrl+Alt+Space** to start/stop dictation.
6. Copy text and press **Ctrl+Alt+R** to read the clipboard aloud using a locally installed Windows voice.
7. Press **Ctrl+Alt+Q** to quit.

## Language
Choose a Vosk model that matches your spoken language. `BLOOM_VOSK_MODEL` can point to a Hindi, Marathi, English or other compatible model. The model itself is not bundled. A model configured for one language may not accurately recognize another.

## Duplicate handling
Only finalized recognition segments are inserted. Interim hypotheses are never typed. An immediate duplicate final segment is ignored for 1.8 seconds. This reduces duplicate insertions but cannot guarantee perfect transcription in every environment.

## Notes
The voice module types into the currently focused application. Do not use it while a password field or other sensitive field is focused. Global hotkeys may not work in elevated/system-secure applications.
