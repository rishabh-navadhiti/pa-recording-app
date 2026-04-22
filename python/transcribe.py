"""
Transcribe an MP3 file using ElevenLabs speech-to-text with diarization.

Usage:
    python transcribe.py --input /path/to/audio.mp3 --output /path/to/transcript.md
"""

import argparse
import logging
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_DIR = Path.home() / 'Documents' / 'AI Medical Notes'
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler(LOG_DIR / 'app.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ElevenLabs config
# ---------------------------------------------------------------------------

ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
ELEVENLABS_MODEL   = 'scribe_v2'

# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe(input_path: str, output_path: str) -> None:
    api_key = os.getenv('ELEVENLABS_API_KEY')
    if not api_key:
        raise ValueError('ELEVENLABS_API_KEY not set in .env file')

    log.info(f'Transcribing: {input_path}')

    with open(input_path, 'rb') as f:
        response = requests.post(
            ELEVENLABS_API_URL,
            headers={'xi-api-key': api_key},
            files={'file': (os.path.basename(input_path), f)},
            data={
                'model_id': ELEVENLABS_MODEL,
                'diarize': 'true',
            },
            timeout=300
        )

    if not response.ok:
        log.error(f'ElevenLabs API error {response.status_code}: {response.text}')
        response.raise_for_status()

    data = response.json()
    markdown = format_transcript(data)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    log.info(f'Transcript saved: {output_path}')


def format_transcript(data: dict) -> str:
    """
    Build markdown from the words array returned by ElevenLabs.
    Groups consecutive words by speaker into paragraphs.
    """
    words = data.get('words', [])

    # Merge consecutive same-speaker words into utterances
    segments = []
    for word_data in words:
        if word_data.get('type') != 'word':
            continue
        speaker_id = word_data.get('speaker_id', 'unknown')
        text = word_data.get('text', '')
        if segments and segments[-1][0] == speaker_id:
            segments[-1] = (speaker_id, segments[-1][1] + ' ' + text)
        else:
            segments.append((speaker_id, text))

    if not segments:
        # Fallback to plain text if no word-level data
        plain = data.get('text', '').strip()
        return f'## Transcript\n\n{plain or "*(No transcription available)*"}\n'

    # Map raw speaker IDs to human-readable labels
    speaker_map = {}
    counter = [1]

    def label(sid):
        if sid not in speaker_map:
            speaker_map[sid] = f'Speaker {counter[0]}'
            counter[0] += 1
        return speaker_map[sid]

    lines = ['## Transcript', '']
    for sid, text in segments:
        lines.append(f'**{label(sid)}:** {text.strip()}')
        lines.append('')

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input',  required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    try:
        transcribe(args.input, args.output)
    except Exception as e:
        log.error(f'Transcription failed: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
