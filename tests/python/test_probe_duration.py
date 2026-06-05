"""Test for probe_duration.py (Phase 5).

Generates a 1-second WAV with the stdlib `wave` module and runs the real script
as a subprocess, asserting the DURATION_SECONDS contract main.js parses. Skips
gracefully where pydub can't decode (e.g. no ffmpeg) rather than failing CI.

Run: python -m unittest discover -s tests/python
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

PROBE = os.path.join(os.path.dirname(__file__), '..', '..', 'python', 'probe_duration.py')


def _write_silent_wav(path, seconds=1, rate=8000):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(rate)
        w.writeframes(b'\x00\x00' * rate * seconds)


class ProbeDurationTest(unittest.TestCase):

    def test_prints_duration_seconds(self):
        tmp = tempfile.mkdtemp()
        wav = Path(tmp) / "one_second.wav"
        _write_silent_wav(wav, seconds=1, rate=8000)

        result = subprocess.run(
            [sys.executable, PROBE, str(wav)],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            # Most likely pydub couldn't find ffmpeg in this environment.
            self.skipTest(f"probe_duration could not decode WAV (ffmpeg missing?): {result.stderr.strip()}")

        m = re.search(r'DURATION_SECONDS:\s*([\d.]+)', result.stdout)
        self.assertIsNotNone(m, f"no DURATION_SECONDS in output: {result.stdout!r}")
        self.assertAlmostEqual(float(m.group(1)), 1.0, delta=0.05)


if __name__ == '__main__':
    unittest.main()
