"""Bloom offline Windows dictation companion.

Recognition is local using Vosk. No browser speech-recognition API or cloud
speech service is used. Install a Vosk model in desktop_companion/models/vosk-model
(or set BLOOM_VOSK_MODEL to its folder).

Hotkeys:
  Ctrl+Alt+Space  Start/stop dictation into the focused application
  Ctrl+Alt+R      Speak clipboard text using installed local voices
  Ctrl+Alt+Q      Quit
"""
from __future__ import annotations
import json
import os
import sys
import time
import threading
from pathlib import Path

try:
    import keyboard
    import pyautogui
    import pyperclip
    import pyttsx3
    import sounddevice as sd
    from vosk import Model, KaldiRecognizer
except ImportError as exc:
    print(f"Missing dependency: {exc}")
    print("Run: py -m pip install -r requirements.txt")
    raise SystemExit(1)

HERE = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get("BLOOM_VOSK_MODEL", str(HERE / "models" / "vosk-model")))
SAMPLE_RATE = int(os.environ.get("BLOOM_SAMPLE_RATE", "16000"))
LANGUAGE_HINT = os.environ.get("BLOOM_LANGUAGE", "en-IN")
stop_event = threading.Event()
recording_lock = threading.Lock()
recording = False
worker = None
model = None
tts_lock = threading.Lock()

def load_vosk_model():
    global model
    if model is not None:
        return model
    if not MODEL_PATH.exists() or not any(MODEL_PATH.iterdir()):
        raise FileNotFoundError(
            f"Offline Vosk model not found: {MODEL_PATH}\n"
            "Download a model from https://alphacephei.com/vosk/models, extract it, "
            "and point BLOOM_VOSK_MODEL to the extracted model folder."
        )
    print(f"Loading offline speech model: {MODEL_PATH}")
    model = Model(str(MODEL_PATH))
    return model

def type_text(text: str) -> None:
    """Paste committed text once, preserving Unicode and punctuation."""
    if not text:
        return
    previous = ""
    try:
        previous = pyperclip.paste()
    except Exception:
        pass
    try:
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.18)
    finally:
        try:
            pyperclip.copy(previous)
        except Exception:
            pass

def speak_clipboard():
    try:
        text = str(pyperclip.paste() or "").strip()
    except Exception:
        text = ""
    if not text:
        print("Copy or select text first, then press Ctrl+Alt+R.")
        return
    def run():
        try:
            with tts_lock:
                engine = pyttsx3.init()
                engine.setProperty("rate", int(os.environ.get("BLOOM_TTS_RATE", "175")))
                engine.setProperty("volume", 1.0)
                engine.say(text)
                engine.runAndWait()
                engine.stop()
        except Exception as exc:
            print("Local text-to-speech error:", exc)
    threading.Thread(target=run, daemon=True).start()

def command_result(text: str) -> str:
    """Only handle exact command phrases; normal speech is preserved verbatim."""
    value = text.strip()
    lower = value.lower().strip(" .,!?")
    commands = {
        "new paragraph": "\n\n",
        "new line": "\n",
        "period": ". ",
        "full stop": ". ",
        "comma": ", ",
        "question mark": "? ",
        "exclamation mark": "! ",
        "exclamation point": "! ",
    }
    if lower in {"stop dictation", "stop listening"}:
        stop_event.set()
        return ""
    if lower in {"cancel that", "scratch that", "delete that"}:
        print("Cancel command heard. No new text inserted; existing text was not changed.")
        return ""
    if lower in commands:
        return commands[lower]
    # Keep words as recognized; only normalize outer whitespace.
    return value

def listen_loop():
    global recording
    try:
        local_model = load_vosk_model()
        recognizer = KaldiRecognizer(local_model, SAMPLE_RATE)
        recognizer.SetWords(True)
        print("Listening offline. Speak one thought at a time; finalized segments are inserted once.")
        last_insert = ""
        last_insert_time = 0.0

        def callback(indata, frames, time_info, status):
            nonlocal last_insert, last_insert_time
            if status:
                print("Microphone:", status, file=sys.stderr)
            if stop_event.is_set():
                raise sd.CallbackStop()
            data = bytes(indata)
            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result() or "{}")
                phrase = str(result.get("text", "")).strip()
                if phrase:
                    # Guard against identical finalized segments emitted immediately twice.
                    nonlocal_last = time.monotonic()
                    normalized = " ".join(phrase.lower().split())
                    if normalized == last_insert and nonlocal_last - last_insert_time < 1.8:
                        print("Skipped repeated segment:", phrase)
                        return
                    output = command_result(phrase)
                    if output:
                        type_text(output + (" " if output[-1:].isalnum() else ""))
                        print("Inserted:", phrase)
                    last_insert = normalized
                    last_insert_time = nonlocal_last

        with sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=8000, dtype="int16",
                               channels=1, callback=callback):
            while not stop_event.wait(0.1):
                pass
            final = json.loads(recognizer.FinalResult() or "{}")
            tail = str(final.get("text", "")).strip()
            if tail:
                normalized = " ".join(tail.lower().split())
                if normalized != last_insert:
                    output = command_result(tail)
                    if output:
                        type_text(output + (" " if output[-1:].isalnum() else ""))
                    print("Inserted final:", tail)
    except Exception as exc:
        print("Voice engine error:", exc)
    finally:
        with recording_lock:
            recording = False
        stop_event.set()
        print("Dictation stopped.")

def toggle():
    global recording, worker
    with recording_lock:
        if recording:
            stop_event.set()
            print("Stopping dictation…")
            return
        stop_event.clear()
        recording = True
        worker = threading.Thread(target=listen_loop, daemon=True)
        worker.start()

def main():
    print("Bloom Voice Module — offline Windows dictation")
    print(f"Model folder: {MODEL_PATH}")
    print("Focus a text field, then press Ctrl+Alt+Space.")
    print("Copy text and press Ctrl+Alt+R for local text-to-speech.")
    print("Press Ctrl+Alt+Q to quit.")
    keyboard.add_hotkey("ctrl+alt+space", toggle)
    keyboard.add_hotkey("ctrl+alt+r", speak_clipboard)
    keyboard.add_hotkey("ctrl+alt+q", lambda: (stop_event.set(), keyboard.unhook_all(), os._exit(0)))
    keyboard.wait()

if __name__ == "__main__":
    main()
