"""
Audio capture for AI Medical Scribe.

Windows: WASAPI loopback via PyAudioWPatch — captures all system audio output.
macOS:   BlackHole virtual audio driver via sounddevice.

Usage:
    python record.py --output /path/to/output.mp3
    python record.py --output /path/to/output.mp3 --device 3
"""

import argparse
import os
import sys
import signal
import tempfile
import threading
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, help='Path for output .mp3 file')
    parser.add_argument('--device', type=int, default=None, help='Device index override')
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Windows — WASAPI loopback via PyAudioWPatch
# ---------------------------------------------------------------------------

def record_windows(output_mp3, device_index_override, stop_event):
    import pyaudiowpatch as pyaudio
    import wave
    import io

    p = pyaudio.PyAudio()

    try:
        if device_index_override is not None:
            device_index = device_index_override
            device_info = p.get_device_info_by_index(device_index)
            log.info(f'Using override device [{device_index}]: {device_info["name"]}')
        else:
            device_index, device_info = get_loopback_device(p)
            if device_index is None:
                print('ERROR: Could not find a WASAPI loopback device.', file=sys.stderr)
                sys.exit(1)
            log.info(f'Using WASAPI loopback device [{device_index}]: {device_info["name"]}')

        sample_rate = int(device_info['defaultSampleRate'])
        channels = device_info['maxInputChannels'] or 2
        chunk = 1024

        # Write to a temp WAV file first
        wav_path = output_mp3.replace('.mp3', '_tmp.wav')
        wf = wave.open(wav_path, 'wb')
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)

        frames_written = [0]

        def callback(in_data, frame_count, time_info, status):
            if stop_event.is_set():
                return (None, pyaudio.paComplete)
            wf.writeframes(in_data)
            frames_written[0] += frame_count
            return (None, pyaudio.paContinue)

        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=chunk,
            stream_callback=callback
        )

        log.info(f'Recording started at {sample_rate}Hz, {channels}ch')
        stream.start_stream()

        while stream.is_active() and not stop_event.is_set():
            stop_event.wait(timeout=0.1)

        stream.stop_stream()
        stream.close()
        wf.close()

        log.info(f'Recorded {frames_written[0]} frames. Converting to MP3...')
        wav_to_mp3(wav_path, output_mp3, sample_rate)
        log.info(f'Saved: {output_mp3}')

    finally:
        p.terminate()


def get_loopback_device(p):
    import pyaudiowpatch as pyaudio
    try:
        wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    except OSError:
        return None, None

    default_output_idx = wasapi_info.get('defaultOutputDevice', -1)
    if default_output_idx < 0:
        return None, None

    default_speakers = p.get_device_info_by_index(default_output_idx)
    log.info(f'Default output device: {default_speakers["name"]}')

    for i in range(p.get_device_count()):
        dev = p.get_device_info_by_index(i)
        if dev.get('isLoopbackDevice') and dev['name'] == default_speakers['name']:
            return i, dev

    # Fallback: any loopback device
    for i in range(p.get_device_count()):
        dev = p.get_device_info_by_index(i)
        if dev.get('isLoopbackDevice') and dev.get('maxInputChannels', 0) > 0:
            log.warning(f'Exact match not found; using fallback loopback: {dev["name"]}')
            return i, dev

    return None, None


# ---------------------------------------------------------------------------
# macOS — BlackHole via sounddevice
# ---------------------------------------------------------------------------

def record_macos(output_mp3, device_index_override, stop_event):
    import sounddevice as sd
    import soundfile as sf
    import numpy as np

    if device_index_override is not None:
        device_index = device_index_override
        dev_info = sd.query_devices(device_index)
        log.info(f'Using override device [{device_index}]: {dev_info["name"]}')
    else:
        device_index, dev_info = get_blackhole_device()
        if device_index is None:
            print(
                'ERROR: BlackHole audio device not found.\n'
                'Install with: brew install blackhole-2ch\n'
                'Then create a Multi-Output Device in Audio MIDI Setup.',
                file=sys.stderr
            )
            sys.exit(1)
        log.info(f'Using BlackHole device [{device_index}]: {dev_info["name"]}')

    sample_rate = 48000  # Standard for BlackHole / Audio MIDI Setup
    channels = min(int(dev_info['max_input_channels']), 2)

    wav_path = output_mp3.replace('.mp3', '_tmp.wav')
    wav_file = sf.SoundFile(wav_path, mode='w', samplerate=sample_rate,
                             channels=channels, subtype='PCM_16')

    def callback(indata, frames, time_info, status):
        if status:
            log.warning(f'sounddevice status: {status}')
        wav_file.write(indata)

    log.info(f'Recording started at {sample_rate}Hz, {channels}ch')

    with sd.InputStream(
        device=device_index,
        channels=channels,
        samplerate=sample_rate,
        callback=callback,
        dtype='int16'
    ):
        stop_event.wait()

    wav_file.close()
    log.info('Stopped recording. Converting to MP3...')
    wav_to_mp3(wav_path, output_mp3, sample_rate)
    log.info(f'Saved: {output_mp3}')


def get_blackhole_device():
    import sounddevice as sd
    for i, dev in enumerate(sd.query_devices()):
        if 'BlackHole' in dev['name'] and dev['max_input_channels'] > 0:
            return i, dev
    return None, None


# ---------------------------------------------------------------------------
# Shared: WAV → MP3 conversion
# ---------------------------------------------------------------------------

def wav_to_mp3(wav_path, mp3_path, original_sample_rate):
    from pydub import AudioSegment
    try:
        audio = AudioSegment.from_wav(wav_path)
        # Downsample to 16kHz mono for speech transcription
        audio = audio.set_frame_rate(16000).set_channels(1)
        os.makedirs(os.path.dirname(mp3_path) or '.', exist_ok=True)
        audio.export(mp3_path, format='mp3')
        os.remove(wav_path)
        log.info(f'WAV deleted: {wav_path}')
    except Exception as e:
        log.error(f'WAV→MP3 conversion failed: {e}')
        raise


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    stop_event = threading.Event()

    def handle_stop(signum, frame):
        log.info(f'Signal {signum} received — stopping...')
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    # Windows-only: SIGBREAK (Ctrl+Break / TerminateProcess fallback)
    try:
        signal.signal(signal.SIGBREAK, handle_stop)
    except AttributeError:
        pass  # Not available on macOS/Linux

    log.info(f'Output: {args.output}')
    log.info(f'Platform: {sys.platform}')

    if sys.platform == 'win32':
        record_windows(args.output, args.device, stop_event)
    elif sys.platform == 'darwin':
        record_macos(args.output, args.device, stop_event)
    else:
        print(f'ERROR: Unsupported platform: {sys.platform}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
