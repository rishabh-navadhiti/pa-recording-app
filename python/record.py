"""
Audio capture for AI Medical Scribe.

Windows: WASAPI loopback via PyAudioWPatch — captures all system audio output.
macOS:   BlackHole virtual audio driver via sounddevice.

Usage:
    python record.py --output /path/to/output.mp3
    python record.py --output /path/to/output.mp3 --device 3
    python record.py --output /path/to/output.mp3 --realtime --api-key sk_... --realtime-output /tmp/transcript.json
"""

import argparse
import array as _array
import asyncio
import base64
import json
import os
import queue as _queue
import sys
import signal
import tempfile
import threading
import logging
import urllib.parse

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
    parser.add_argument('--realtime', action='store_true', help='Stream audio to ElevenLabs in real time during recording')
    parser.add_argument('--api-key', default='', help='ElevenLabs API key (required when --realtime is set)')
    parser.add_argument('--realtime-output', default='', help='Path to write the realtime transcript JSON')
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Real-time streaming transcriber
# ---------------------------------------------------------------------------

class RealtimeTranscriber:
    """Streams PCM audio chunks to the ElevenLabs streaming STT WebSocket in a
    background thread while recording is in progress.  When stop() is called the
    thread flushes the queue, waits for the server's final response, and writes
    a JSON file that Node reads instead of making a fresh batch API call.

    Output file format mirrors the ElevenLabs batch response so the existing
    formatTranscript() in elevenLabs.js works unchanged:
        {"words": [...], "text": "..."}

    NOTE: The exact ElevenLabs streaming STT WebSocket protocol (init message
    fields, binary audio format, event shapes) should be verified against their
    current API docs.  The implementation below follows the documented protocol
    as of mid-2025 and is the starting point for integration testing.
    """

    _WS_URI = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"

    def __init__(self, api_key, output_path, sample_rate, channels):
        self._api_key     = api_key
        self._output_path = output_path
        self._sample_rate = sample_rate
        self._channels    = channels
        self._audio_q     = _queue.Queue()
        self._words       = []
        self._text_parts  = []
        self._done        = threading.Event()
        self._error       = None

    def start(self):
        """Spawn the background WebSocket thread (non-blocking)."""
        threading.Thread(target=self._run, daemon=True).start()

    def send_audio(self, pcm_bytes):
        """Thread-safe.  Called from the audio capture callback with each PCM chunk."""
        self._audio_q.put(pcm_bytes)

    def stop(self, timeout=30):
        """Signal end of audio and wait for the final transcript (max timeout seconds).
        Raises RuntimeError if the transcriber encountered an error or timed out;
        caller logs to stderr so Node falls back to batch transcription.
        """
        self._audio_q.put(None)   # sentinel → producer sends {"type":"end"} and exits
        if not self._done.wait(timeout=timeout):
            self._error = f'Realtime transcriber did not complete within {timeout}s'
        if self._error:
            raise RuntimeError(self._error)

    def _run(self):
        try:
            asyncio.run(self._stream())
        except Exception as e:
            self._error = str(e)
        finally:
            self._done.set()

    async def _stream(self):
        from elevenlabs.realtime.scribe import ScribeRealtime, AudioFormat, CommitStrategy
        from elevenlabs.realtime.connection import RealtimeEvents

        # Map device sample rate to the nearest supported AudioFormat.
        _format_map = {
            8000:  AudioFormat.PCM_8000,
            16000: AudioFormat.PCM_16000,
            22050: AudioFormat.PCM_22050,
            24000: AudioFormat.PCM_24000,
            44100: AudioFormat.PCM_44100,
            48000: AudioFormat.PCM_48000,
        }
        audio_fmt = _format_map.get(self._sample_rate, AudioFormat.PCM_16000)

        scribe = ScribeRealtime(api_key=self._api_key)
        conn = await scribe.connect({
            "model_id":           "scribe_v2_realtime",
            "audio_format":       audio_fmt,
            "sample_rate":        self._sample_rate,
            "commit_strategy":    CommitStrategy.VAD,
            "include_timestamps": True,
        })

        def _on_transcript(data):
            words = data.get("words", [])
            if isinstance(words, list):
                self._words.extend(
                    w for w in words
                    if isinstance(w, dict) and w.get("type") == "word"
                )
            t = data.get("text", "")
            if t:
                self._text_parts.append(t)

        _errors = []
        conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT,                _on_transcript)
        conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, _on_transcript)
        conn.on(RealtimeEvents.ERROR, lambda d: _errors.append(d.get("error", str(d))))

        # Stream audio chunks until sentinel None arrives.
        # ElevenLabs realtime expects MONO PCM — downmix stereo before sending.
        loop = asyncio.get_running_loop()
        while True:
            chunk = await loop.run_in_executor(None, self._audio_q.get)
            if chunk is None:
                break
            if self._channels == 2:
                # Stereo 16-bit interleaved [L0,R0,L1,R1,...] -> left channel only.
                arr = _array.array('h', chunk)
                chunk = _array.array('h', arr[::2]).tobytes()
            await conn.send({"audio_base_64": base64.b64encode(chunk).decode()})

        # Flush remaining audio and wait for final committed_transcript.
        await conn.commit()
        await asyncio.sleep(10.0)

        # Check for real API errors (auth, quota) — filter out close-frame noise.
        fatal_errors = [
            e for e in _errors
            if "sent 1000" not in e and "no close frame" not in e
        ]
        if fatal_errors:
            raise RuntimeError(f"ElevenLabs: {fatal_errors[0]}")

        # Write output BEFORE closing — a failed close must not discard the transcript.
        result = {
            "words": self._words,
            "text":  " ".join(self._text_parts),
        }
        with open(self._output_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
        log.info(f"Realtime transcript written: {self._output_path}")

        try:
            await conn.close()
        except Exception:
            pass  # server not sending a close frame is non-fatal


# ---------------------------------------------------------------------------
# Windows — WASAPI loopback via PyAudioWPatch
# ---------------------------------------------------------------------------

def record_windows(output_mp3, device_index_override, stop_event, pause_event, realtime_args=None, discard_event=None):
    """
    realtime_args: argparse.Namespace with .api_key and .realtime_output set,
                   or None if realtime transcription is disabled.
    """
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

        # Create the realtime transcriber now that we know the device format.
        transcriber = None
        if realtime_args:
            transcriber = RealtimeTranscriber(
                api_key=realtime_args.api_key,
                output_path=realtime_args.realtime_output,
                sample_rate=sample_rate,
                channels=channels,
            )
            transcriber.start()
            log.info(f'Realtime transcriber started ({sample_rate}Hz, {channels}ch)')

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
                if transcriber:
                    transcriber.send_audio(in_data)
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

        # Discard path: abandon realtime transcriber (daemon thread dies with
        # the process), delete the temp WAV, and exit cleanly with no ERROR output.
        if discard_event and discard_event.is_set():
            if transcriber:
                log.info('Discarding — realtime transcriber abandoned.')
            try:
                os.remove(wav_path)
            except OSError:
                pass
            return

        if frames_written[0] == 0:
            log.error('No audio frames captured — wrong loopback device or no system audio playing.')
            # Clean up the empty WAV
            try:
                os.remove(wav_path)
            except OSError:
                pass
            sys.exit(1)

        # Finalize realtime transcript (drain WS queue, await server final response).
        # Must run after the stream closes so no more audio arrives in the queue,
        # and before WAV→MP3 so the total wall-time is accurate.
        if transcriber:
            try:
                log.info('Waiting for realtime transcript to finalize...')
                transcriber.stop()
                log.info('Realtime transcript complete.')
            except Exception as e:
                print(f'ERROR: Realtime transcriber: {e}', file=sys.stderr)
                # Node will detect the missing/empty JSON and fall back to batch.

        duration_seconds = frames_written[0] / sample_rate
        print(f'DURATION_SECONDS: {duration_seconds:.3f}', flush=True)

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

    i, dev, reason = select_loopback_index(loopback_devices, default_name)
    if i is not None:
        msg = f'Matched loopback ({reason}): [{i}] {dev["name"]}'
        # Passes 4-5 are sketchy fallbacks (no name match) — keep them at warning level.
        (log.warning if reason in ('speaker-type', 'first-available') else log.info)(msg)
    return i, dev


def select_loopback_index(loopback_devices, default_name):
    """Pure 5-pass WASAPI-loopback matcher (no PyAudio dependency — pytest-able).

    loopback_devices: list of (index, dev_dict) where dev_dict has 'name'.
    Returns (index, dev, reason) or (None, None, None) when the list is empty.
    The pass order/conditions mirror the original get_loopback_device heuristic
    exactly; only the logging moved out to the caller.
    """
    # Pass 1: loopback name starts with the default output name
    # (WASAPI loopback names are typically "<output name> [Loopback]")
    for i, dev in loopback_devices:
        if dev['name'].startswith(default_name):
            return i, dev, 'startswith'

    # Pass 2: default output name is contained in the loopback name (substring)
    for i, dev in loopback_devices:
        if default_name in dev['name']:
            return i, dev, 'substring'

    # Pass 3: loopback name is contained in the default output name (reverse substring)
    # Handles cases where the loopback name is slightly shorter than the output name
    for i, dev in loopback_devices:
        loopback_base = dev['name'].replace(' [Loopback]', '').strip()
        if loopback_base in default_name:
            return i, dev, 'reverse-substring'

    # Pass 4: prefer a loopback whose name contains "Speakers" over digital/S/PDIF outputs
    for i, dev in loopback_devices:
        if 'Speakers' in dev['name'] or 'Headphone' in dev['name'] or 'Headset' in dev['name']:
            return i, dev, 'speaker-type'

    # Pass 5: last resort — first available loopback
    if loopback_devices:
        i, dev = loopback_devices[0]
        return i, dev, 'first-available'

    return None, None, None


# ---------------------------------------------------------------------------
# macOS — BlackHole via sounddevice
# ---------------------------------------------------------------------------

def record_macos(output_mp3, device_index_override, stop_event, pause_event, realtime_args=None, discard_event=None):
    """
    realtime_args: argparse.Namespace with .api_key and .realtime_output set,
                   or None if realtime transcription is disabled.
    """
    import sounddevice as sd
    import soundfile as sf

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

    # Use the device's reported default rate (parity with Windows) rather than a
    # hardcoded 48k — BlackHole can be set to 44.1/96k in Audio MIDI Setup, and
    # opening the stream at a rate the device doesn't run at can fail.
    sample_rate = int(dev_info.get('default_samplerate') or 48000)
    channels = min(int(dev_info['max_input_channels']), 2)

    # Create the realtime transcriber now that we know the device format.
    transcriber = None
    if realtime_args:
        transcriber = RealtimeTranscriber(
            api_key=realtime_args.api_key,
            output_path=realtime_args.realtime_output,
            sample_rate=sample_rate,
            channels=channels,
        )
        transcriber.start()
        log.info(f'Realtime transcriber started ({sample_rate}Hz, {channels}ch)')

    wav_path = output_mp3.replace('.mp3', '_tmp.wav')
    wav_file = sf.SoundFile(wav_path, mode='w', samplerate=sample_rate,
                             channels=channels, subtype='PCM_16')

    def callback(indata, frames, time_info, status):
        if status:
            log.warning(f'sounddevice status: {status}')
        # Don't capture frames after stop is requested (parity with the Windows
        # callback's paComplete short-circuit). The InputStream context exit
        # below performs the actual stream teardown.
        if stop_event.is_set():
            return
        if not pause_event.is_set():
            wav_file.write(indata)
            if transcriber:
                # indata is a numpy int16 array; convert to raw bytes for the WS.
                transcriber.send_audio(indata.tobytes())

    log.info(f'Recording started at {sample_rate}Hz, {channels}ch')

    with sd.InputStream(
        device=device_index,
        channels=channels,
        samplerate=sample_rate,
        callback=callback,
        dtype='int16'
    ):
        stop_event.wait()

    # tell() returns current write position = total frames written
    total_frames = wav_file.tell()
    wav_file.close()

    log.info(f'Recorded {total_frames} frames.')

    # Discard path: abandon realtime transcriber, delete temp WAV, exit cleanly.
    if discard_event and discard_event.is_set():
        if transcriber:
            log.info('Discarding — realtime transcriber abandoned.')
        try:
            os.remove(wav_path)
        except OSError:
            pass
        return

    # 0-frames guard (parity with Windows): a silent capture means BlackHole
    # isn't receiving system audio. Delete the empty WAV and fail rather than
    # producing a silent MP3 that gets sent to transcription.
    if total_frames == 0:
        log.error('No audio frames captured — BlackHole is not receiving system audio. '
                  'Check that a Multi-Output Device (including BlackHole) is selected as the system output.')
        try:
            os.remove(wav_path)
        except OSError:
            pass
        sys.exit(1)

    # Finalize realtime transcript before WAV→MP3 (same reasoning as Windows path).
    if transcriber:
        try:
            log.info('Waiting for realtime transcript to finalize...')
            transcriber.stop()
            log.info('Realtime transcript complete.')
        except Exception as e:
            print(f'ERROR: Realtime transcriber: {e}', file=sys.stderr)

    print(f'DURATION_SECONDS: {total_frames / sample_rate:.3f}', flush=True)
    log.info('Stopped recording. Converting to MP3...')
    wav_to_mp3(wav_path, output_mp3, sample_rate)
    log.info(f'Saved: {output_mp3}')


# Known macOS virtual-audio loopback drivers, in auto-select priority order.
# These all expose *system audio* as an input device; an ordinary input (e.g. the
# built-in mic) is deliberately NOT a fallback — capturing the mic instead of
# system audio would be silently wrong.
MACOS_CAPTURE_NEEDLES = ('blackhole', 'aggregate', 'loopback', 'soundflower')


def is_macos_capture_candidate(name):
    """True if `name` looks like a system-audio loopback device (case-insensitive)."""
    n = (name or '').lower()
    return any(needle in n for needle in MACOS_CAPTURE_NEEDLES)


def select_macos_input_index(devices):
    """Pure macOS capture-device matcher (no sounddevice dependency — pytest-able).

    devices: list of dicts with 'name' + 'max_input_channels' (sd.query_devices()
    shape). Returns (index, dev) for the highest-priority input-capable virtual
    device, or (None, None). Priority follows MACOS_CAPTURE_NEEDLES (BlackHole
    first); never returns an arbitrary input device.
    """
    for needle in MACOS_CAPTURE_NEEDLES:
        for i, dev in enumerate(devices):
            if needle in (dev['name'] or '').lower() and dev.get('max_input_channels', 0) > 0:
                return i, dev
    return None, None


def get_blackhole_device():
    import sounddevice as sd
    return select_macos_input_index(list(sd.query_devices()))


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
        all_devices = list(sd.query_devices())
        best_idx, _ = select_macos_input_index(all_devices)
        devices = []
        for i, dev in enumerate(all_devices):
            if is_macos_capture_candidate(dev['name']) and dev['max_input_channels'] > 0:
                devices.append({
                    'index': i,
                    'name': dev['name'],
                    'isDefault': i == best_idx
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

    stop_event    = threading.Event()
    pause_event   = threading.Event()
    discard_event = threading.Event()

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
                elif cmd == 'discard':
                    log.info('stdin: discard')
                    discard_event.set()
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

    if args.realtime:
        if not args.api_key:
            print('ERROR: --api-key is required when --realtime is set', file=sys.stderr)
            sys.exit(1)
        if not args.realtime_output:
            print('ERROR: --realtime-output is required when --realtime is set', file=sys.stderr)
            sys.exit(1)
        log.info(f'Realtime transcription enabled -> {args.realtime_output}')

    # realtime_args is passed to the platform function so it can create the
    # RealtimeTranscriber after learning the device sample_rate and channels.
    realtime_args = args if args.realtime else None

    if sys.platform == 'win32':
        record_windows(args.output, args.device, stop_event, pause_event,
                       realtime_args=realtime_args, discard_event=discard_event)
    elif sys.platform == 'darwin':
        record_macos(args.output, args.device, stop_event, pause_event,
                     realtime_args=realtime_args, discard_event=discard_event)
    else:
        print(f'ERROR: Unsupported platform: {sys.platform}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
