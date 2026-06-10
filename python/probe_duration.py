"""Print DURATION_SECONDS: <float> for an audio file given as argv[1].

Used by main.js (process-audio-file) to probe the length of an uploaded
audio file without interpolating the path into a -c string.
"""
import sys
from pydub import AudioSegment

audio = AudioSegment.from_file(sys.argv[1])
print(f"DURATION_SECONDS: {audio.duration_seconds:.3f}")
