"""Disposable Azure SDK worker. The parent enforces a wall-clock timeout."""
import base64
import json
import sys
from server import _azure_sdk_speak_bytes

if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        audio, cues = _azure_sdk_speak_bytes(request["text"], request["voice"])
        print(json.dumps({"audio_base64": base64.b64encode(audio).decode("ascii"), "mouth_cues": cues}))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
