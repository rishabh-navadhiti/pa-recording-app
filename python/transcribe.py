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

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Logging — write to app.log in the same location as main.js uses
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
# Transcription
# ---------------------------------------------------------------------------

def transcribe(input_path: str, output_path: str) -> None:
    api_key = os.getenv('ELEVENLABS_API_KEY')
    if not api_key:
        raise ValueError('ELEVENLABS_API_KEY not set in environment / .env file')

    from elevenlabs import ElevenLabs

    client = ElevenLabs(api_key=api_key)
    log.info(f'Transcribing: {input_path}')

    with open(input_path, 'rb') as f:
        result = client.speech_to_text.convert(
            file=f,
            diarize=True
        )

    markdown = format_transcript(result)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    log.info(f'Transcript saved: {output_path}')


def format_transcript(result) -> str:
    """
    Group consecutive utterances by speaker and format as markdown.
    Handles both dict-style and object-style API responses.
    """
    lines = ['## Transcript', '']

    utterances = []

    # ElevenLabs response may be an object with .utterances or a dict
    raw_utterances = None
    if hasattr(result, 'utterances') and result.utterances:
        raw_utterances = result.utterances
    elif isinstance(result, dict) and result.get('utterances'):
        raw_utterances = result['utterances']

    if not raw_utterances:
        # Fallback: plain text with no diarization
        text = ''
        if hasattr(result, 'text'):
            text = result.text or ''
        elif isinstance(result, dict):
            text = result.get('text', '')
        lines.append(text or '*(No transcription available)*')
        return '\n'.join(lines)

    # Merge consecutive same-speaker utterances
    merged = []
    for utt in raw_utterances:
        speaker = getattr(utt, 'speaker_id', None) or (utt.get('speaker_id') if isinstance(utt, dict) else None) or 'Unknown'
        text = getattr(utt, 'text', None) or (utt.get('text') if isinstance(utt, dict) else '') or ''
        text = text.strip()
        if not text:
            continue
        if merged and merged[-1][0] == speaker:
            merged[-1] = (speaker, merged[-1][1] + ' ' + text)
        else:
            merged.append((speaker, text))

    # Format speaker labels: Speaker 1, Speaker 2, ...
    speaker_map = {}
    counter = [1]

    def label(speaker_id):
        if speaker_id not in speaker_map:
            speaker_map[speaker_id] = f'Speaker {counter[0]}'
            counter[0] += 1
        return speaker_map[speaker_id]

    for speaker_id, text in merged:
        lines.append(f'**{label(speaker_id)}:** {text}')
        lines.append('')

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input',  required=True, help='Path to input .mp3 file')
    parser.add_argument('--output', required=True, help='Path to output transcript.md')
    args = parser.parse_args()

    try:
        transcribe(args.input, args.output)
    except Exception as e:
        log.error(f'Transcription failed: {e}')
        # Write a failure note so the case folder always has a transcript file
        try:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(f'## Transcript\n\n*(Transcription failed: {e})*\n')
        except Exception as write_err:
            log.error(f'Could not write failure note: {write_err}')
        sys.exit(1)


if __name__ == '__main__':
    main()
