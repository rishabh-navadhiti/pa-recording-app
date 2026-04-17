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

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger(__name__)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=False, help='Path for output .mp3 file')
    parser.add_argument('--device', type=int, default=None, help='Device index override')
    parser.add_argument('--list-devices', action='store_true', help='List loopback devices as JSON and exit')
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Windows — WASAPI loopback via PyAudioWPatch
# ---------------------------------------------------------------------------

def record_windows(output_mp3, device_index_override, stop_event, pause_event):
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
            if status:
                log.warning(f'Audio callback status: {status}')
            if stop_event.is_set():
                return (None, pyaudio.paComplete)
            if not pause_event.is_set():
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

        log.info(f'Recorded {frames_written[0]} frames.')

        if frames_written[0] == 0:
            log.error('No audio frames captured — wrong loopback device or no system audio playing.')
            # Clean up the empty WAV
            try:
                os.remove(wav_path)
            except OSError:
                pass
            sys.exit(1)

        log.info('Converting to MP3...')
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
    default_name = default_speakers['name']
    log.info(f'Default output device: {default_name}')

    # Log all available loopback devices to aid debugging
    loopback_devices = []
    for i in range(p.get_device_count()):
        dev = p.get_device_info_by_index(i)
        if dev.get('isLoopbackDevice') and dev.get('maxInputChannels', 0) > 0:
            loopback_devices.append((i, dev))
            log.info(f'  Loopback device [{i}]: {dev["name"]}')

    if not loopback_devices:
        return None, None

    # Pass 1: loopback name starts with the default output name
    # (WASAPI loopback names are typically "<output name> [Loopback]")
    for i, dev in loopback_devices:
        if dev['name'].startswith(default_name):
            log.info(f'Matched loopback by startswith: [{i}] {dev["name"]}')
            return i, dev

    # Pass 2: default output name is contained in the loopback name (substring)
    for i, dev in loopback_devices:
        if default_name in dev['name']:
            log.info(f'Matched loopback by substring: [{i}] {dev["name"]}')
            return i, dev

    # Pass 3: loopback name is contained in the default output name (reverse substring)
    # Handles cases where the loopback name is slightly shorter than the output name
    for i, dev in loopback_devices:
        loopback_base = dev['name'].replace(' [Loopback]', '').strip()
        if loopback_base in default_name:
            log.info(f'Matched loopback by reverse substring: [{i}] {dev["name"]}')
            return i, dev

    # Pass 4: prefer a loopback whose name contains "Speakers" over digital/S/PDIF outputs
    for i, dev in loopback_devices:
        if 'Speakers' in dev['name'] or 'Headphone' in dev['name'] or 'Headset' in dev['name']:
            log.warning(f'No name match found; preferring speaker-type loopback: [{i}] {dev["name"]}')
            return i, dev

    # Pass 5: last resort — first available loopback
    i, dev = loopback_devices[0]
    log.warning(f'No suitable match found; using first available loopback: [{i}] {dev["name"]}')
    return i, dev


# ---------------------------------------------------------------------------
# macOS — BlackHole via sounddevice
# ---------------------------------------------------------------------------

def record_macos(output_mp3, device_index_override, stop_event, pause_event):
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
        if not pause_event.is_set():
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

def list_devices_json():
    """Print loopback devices as JSON to stdout and exit."""
    import json
    if sys.platform == 'win32':
        import pyaudiowpatch as pyaudio
        p = pyaudio.PyAudio()
        try:
            wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
            default_idx = wasapi_info.get('defaultOutputDevice', -1)
            default_name = ''
            if default_idx >= 0:
                default_name = p.get_device_info_by_index(default_idx).get('name', '')

            devices = []
            for i in range(p.get_device_count()):
                dev = p.get_device_info_by_index(i)
                if dev.get('isLoopbackDevice') and dev.get('maxInputChannels', 0) > 0:
                    devices.append({
                        'index': i,
                        'name': dev['name'],
                        'isDefault': default_name != '' and dev['name'].startswith(default_name)
                    })
            print(json.dumps({'devices': devices, 'defaultOutput': default_name}))
        finally:
            p.terminate()
    elif sys.platform == 'darwin':
        import sounddevice as sd
        devices = []
        for i, dev in enumerate(sd.query_devices()):
            if 'BlackHole' in dev['name'] and dev['max_input_channels'] > 0:
                devices.append({
                    'index': i,
                    'name': dev['name'],
                    'isDefault': True
                })
        print(json.dumps({'devices': devices, 'defaultOutput': 'BlackHole'}))
    else:
        print(json.dumps({'devices': [], 'defaultOutput': ''}))


def main():
    args = parse_args()

    if args.list_devices:
        list_devices_json()
        return

    if not args.output:
        print('ERROR: --output is required when not using --list-devices', file=sys.stderr)
        sys.exit(1)

    stop_event = threading.Event()
    pause_event = threading.Event()

    def handle_stop(signum, frame):
        log.info(f'Signal {signum} received — stopping...')
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    # Windows-only: SIGBREAK (Ctrl+Break fallback)
    try:
        signal.signal(signal.SIGBREAK, handle_stop)
    except AttributeError:
        pass  # Not available on macOS/Linux

    # Primary stop mechanism on Windows: watch stdin for commands from Node.
    # Node writes 'stop\n', 'pause\n', or 'resume\n' to stdin.
    def watch_stdin():
        try:
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == 'stop':
                    log.info('stdin: stop')
                    stop_event.set()
                    break
                elif cmd == 'pause':
                    log.info('stdin: pause')
                    pause_event.set()
                elif cmd == 'resume':
                    log.info('stdin: resume')
                    pause_event.clear()
        except Exception:
            pass
        finally:
            log.info('stdin closed — stopping...')
            stop_event.set()

    stdin_thread = threading.Thread(target=watch_stdin, daemon=True)
    stdin_thread.start()

    log.info(f'Output: {args.output}')
    log.info(f'Platform: {sys.platform}')

    if sys.platform == 'win32':
        record_windows(args.output, args.device, stop_event, pause_event)
    elif sys.platform == 'darwin':
        record_macos(args.output, args.device, stop_event, pause_event)
    else:
        print(f'ERROR: Unsupported platform: {sys.platform}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
