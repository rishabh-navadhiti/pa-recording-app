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
import time
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
    parser.add_argument('--mic', action='store_true', help='Also capture the local microphone and mix it with the loopback audio')
    parser.add_argument('--mic-device', type=int, default=None, help='Microphone device index override (default: OS default input device)')
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Real-time streaming transcriber
# ---------------------------------------------------------------------------

class _FatalRealtimeError(Exception):
    """Raised for unrecoverable realtime errors (auth / quota) so the reconnect
    loop gives up immediately instead of spinning. Anything else is treated as a
    transient drop and reconnected."""
    pass


# Substrings that mark an UNRECOVERABLE realtime error (bad key, out of quota).
# A normal WebSocket close ("1000", "no close frame", "going away") is NOT fatal
# — that is exactly the mid-recording drop we want to reconnect from.
_FATAL_REALTIME_PATTERNS = (
    '401', '403', '402', 'unauthorized', 'invalid api key', 'invalid_api_key',
    'forbidden', 'quota', 'usage limit', 'payment',
)


def _is_fatal_realtime_error(err):
    """True if the realtime error text looks like auth/quota (don't reconnect)."""
    s = str(err or '').lower()
    return any(p in s for p in _FATAL_REALTIME_PATTERNS)


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

    def result(self):
        """Return the collected transcript in memory (valid after stop()).
        Used by the dual-transcriber (mic + loopback) merge path."""
        return {"words": list(self._words), "text": " ".join(self._text_parts)}

    def stop(self, timeout=60):
        """Signal end of audio and wait for the final transcript (max timeout seconds).
        Raises RuntimeError if the transcriber encountered an error or timed out;
        caller logs to stderr so Node falls back to batch transcription.

        The timeout is generous (60s) because a reconnect in flight plus the
        post-commit settle window can take a while on a flaky network.
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

    # Reconnect tuning. A drop mid-recording must NOT end transcription — only the
    # stop sentinel ends it. We reconnect transparently and keep streaming. The
    # cap only trips when we cannot establish a connection at all (a successful
    # connect resets the counter), so persistent flakiness still makes progress.
    _MAX_CONNECT_FAILURES = 12
    _RECONNECT_DELAY_S    = 1.0

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
        connect_opts = {
            "model_id":           "scribe_v2_realtime",
            "audio_format":       audio_fmt,
            "sample_rate":        self._sample_rate,
            "commit_strategy":    CommitStrategy.VAD,
            "include_timestamps": True,
        }

        loop = asyncio.get_running_loop()
        ended         = False   # stop sentinel received → finalize and exit for good
        pending       = None    # chunk pulled but not yet acked-sent → retry after reconnect
        sent_seconds  = 0.0     # cumulative MONO audio seconds sent across ALL connections
        connect_fails = 0

        # The capture callback keeps pushing audio into self._audio_q the whole
        # time — including while we are reconnecting — so nothing is lost during a
        # gap; the backlog drains once the new connection is up. Word timestamps
        # are per-connection (reset to 0 each reconnect), so each connection's
        # words are shifted by sent_seconds-at-connect to keep ONE continuous
        # timeline (load-bearing for the Option B merge sort on long recordings).
        while not ended:
            conn  = None
            chunk = None
            try:
                scribe = ScribeRealtime(api_key=self._api_key)
                conn = await scribe.connect(connect_opts)
                connect_fails = 0
                base_offset = sent_seconds

                def _on_transcript(data, _base=base_offset):
                    words = data.get("words", [])
                    if isinstance(words, list):
                        for w in words:
                            if isinstance(w, dict) and w.get("type") == "word":
                                w = dict(w)
                                for k in ("start", "end"):
                                    if isinstance(w.get(k), (int, float)):
                                        w[k] = w[k] + _base
                                self._words.append(w)
                    t = data.get("text", "")
                    if t:
                        self._text_parts.append(t)

                _errors = []
                conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT,                 _on_transcript)
                conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, _on_transcript)
                conn.on(RealtimeEvents.ERROR, lambda d: _errors.append(d.get("error", str(d))))

                # ---- send loop (ElevenLabs realtime expects MONO PCM) ----
                while True:
                    if pending is not None:
                        chunk = pending          # retry the chunk the drop interrupted
                    else:
                        chunk = await loop.run_in_executor(None, self._audio_q.get)
                    if chunk is None:
                        ended = True
                        break
                    send_bytes = chunk
                    if self._channels == 2:
                        arr = _array.array('h', chunk)        # [L0,R0,L1,R1,...] -> L only
                        send_bytes = _array.array('h', arr[::2]).tobytes()
                    await conn.send({"audio_base_64": base64.b64encode(send_bytes).decode()})
                    pending = None                            # delivered
                    sent_seconds += (len(send_bytes) / 2) / self._sample_rate

                    fatal = next((e for e in _errors if _is_fatal_realtime_error(e)), None)
                    if fatal:
                        raise _FatalRealtimeError(fatal)

                # ---- sentinel received: finalize on this connection ----
                await conn.commit()
                await asyncio.sleep(10.0)
                try:
                    await conn.close()
                except Exception:
                    pass  # server not sending a close frame is non-fatal
                break  # done for good

            except _FatalRealtimeError as e:
                self._error = f"ElevenLabs: {e}"   # auth/quota — don't spin; Node falls back to batch
                break
            except Exception as e:
                msg = str(e)
                if ended:
                    # Drop during finalize (commit/close) after all audio was sent.
                    # We already hold the words — treat as complete, don't fail.
                    log.warning(f"Realtime finalize error after audio end (non-fatal): {msg}")
                    break
                # Transient drop mid-stream → keep the un-acked chunk and reconnect.
                if chunk is not None:
                    pending = chunk
                connect_fails += 1
                if connect_fails > self._MAX_CONNECT_FAILURES:
                    self._error = f"Realtime reconnect failed after {self._MAX_CONNECT_FAILURES} attempts: {msg}"
                    break
                log.warning(f"Realtime connection lost ({msg}); reconnecting "
                            f"(attempt {connect_fails}/{self._MAX_CONNECT_FAILURES})...")
                try:
                    if conn:
                        await conn.close()
                except Exception:
                    pass
                await asyncio.sleep(self._RECONNECT_DELAY_S)
                continue

        # Write output once, at the very end. Skip on fatal error so the file is
        # absent/empty and Node falls back to batch. output_path is None in the
        # dual-transcriber path — the caller merges result() in memory instead.
        if self._output_path and not self._error:
            result = {"words": self._words, "text": " ".join(self._text_parts)}
            with open(self._output_path, "w", encoding="utf-8") as f:
                json.dump(result, f)
            log.info(f"Realtime transcript written: {self._output_path} ({len(self._words)} words)")


# ---------------------------------------------------------------------------
# Dual-transcriber merge (Option B): mic + loopback → one transcript
# ---------------------------------------------------------------------------

def merge_realtime_transcripts(loop_words, loop_text, mic_words, mic_text, mic_offset_ms):
    """Merge two realtime transcripts (call audio + microphone) into one
    ElevenLabs-shaped result {"words": [...], "text": "..."}.

    - Loopback words keep their own speaker_id when the API diarised the call
      (doctor/patient); words with no speaker get 'call'. Mic words are all the
      local speaker → 'scribe'. The string ids never collide with the loopback's
      (usually integer) ids, so formatTranscript() labels them as distinct
      "Speaker N" — giving scribe-vs-call separation for free.
    - Mic word timestamps are relative to the mic stream's own start, so they are
      shifted by mic_offset_ms (mic_start - loop_start, common monotonic clock)
      onto the loopback timeline before everything is sorted by start time.
      formatTranscript() ignores timestamps, but the sort fixes interleave order.
    """
    offset_s = (mic_offset_ms or 0) / 1000.0
    merged = []

    for w in (loop_words or []):
        if not isinstance(w, dict):
            continue
        w = dict(w)
        if not w.get('speaker_id') and w.get('speaker_id') != 0:
            w['speaker_id'] = 'call'
        merged.append(w)

    for w in (mic_words or []):
        if not isinstance(w, dict):
            continue
        w = dict(w)
        for k in ('start', 'end'):
            if isinstance(w.get(k), (int, float)):
                w[k] = w[k] + offset_s
        w['speaker_id'] = 'scribe'
        merged.append(w)

    # Stable sort by start time; words without a usable start fall to the end
    # while keeping their relative order.
    merged.sort(key=lambda w: w['start'] if isinstance(w.get('start'), (int, float)) else float('inf'))

    text = ' '.join(t for t in [(loop_text or '').strip(), (mic_text or '').strip()] if t).strip()
    return {'words': merged, 'text': text}


def finalize_realtime_transcripts(transcriber, mic_transcriber, realtime_args, mic_offset_ms):
    """Stop the loopback (and optional mic) realtime transcribers and, when both
    ran, merge their results and overwrite the realtime output file.

    CRITICAL: both transcribers must ALWAYS be stopped, even if one fails. stop()
    is what delivers the queue sentinel that unblocks each transcriber's
    `queue.get()` (which runs on a non-daemon executor thread). Abandoning a
    transcriber leaves that thread parked forever and the whole process hangs on
    exit — so never early-return before draining the mic transcriber.

    Fallback semantics:
      - loopback ok + mic ok   → merge, overwrite the realtime file (Option B).
      - loopback ok + mic fail → keep the loopback-only file (call-audio only).
      - loopback fail          → remove any stale file so Node falls back to BATCH
                                  on the mixed MP3 (which contains both voices).
    Shared by the Windows and macOS capture paths.
    """
    out = realtime_args.realtime_output if realtime_args else None

    loop_ok = False
    if transcriber:
        try:
            log.info('Waiting for realtime transcript to finalize...')
            transcriber.stop()
            loop_ok = True
            log.info('Realtime transcript complete.')
        except Exception as e:
            print(f'ERROR: Realtime transcriber: {e}', file=sys.stderr)

    # ALWAYS drain the mic transcriber (see docstring) — never skip this.
    mic_ok = False
    if mic_transcriber:
        try:
            log.info('Waiting for mic realtime transcript to finalize...')
            mic_transcriber.stop()
            mic_ok = True
            log.info('Mic realtime transcript complete.')
        except Exception as e:
            print(f'MIC_WARNING: mic realtime transcript failed ({e}) — using call audio transcript only',
                  file=sys.stderr, flush=True)

    if loop_ok and mic_ok and out:
        try:
            loop_res = transcriber.result()
            mic_res  = mic_transcriber.result()
            merged = merge_realtime_transcripts(
                loop_res['words'], loop_res['text'],
                mic_res['words'],  mic_res['text'],
                mic_offset_ms,
            )
            with open(out, 'w', encoding='utf-8') as f:
                json.dump(merged, f)
            log.info(f'Merged mic + loopback realtime transcript written: '
                     f'{out} ({len(merged["words"])} words)')
        except Exception as e:
            log.warning(f'Realtime merge failed, keeping loopback-only transcript: {e}')
        return

    # Loopback failed → no usable realtime transcript. Remove any stale/partial
    # file so Node falls back to batch on the mixed MP3 (both voices present).
    if not loop_ok and out:
        try:
            os.remove(out)
            log.info('Realtime transcript unavailable — removed stale file; Node will batch-transcribe the mixed MP3.')
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Windows — WASAPI loopback via PyAudioWPatch
# ---------------------------------------------------------------------------

def record_windows(output_mp3, device_index_override, stop_event, pause_event, realtime_args=None, discard_event=None,
                   mic_enabled=False, mic_device_override=None):
    """
    realtime_args: argparse.Namespace with .api_key and .realtime_output set,
                   or None if realtime transcription is disabled.
    mic_enabled:   when True, open a second input stream on the default (or
                   overridden) microphone and mix it with the loopback audio at
                   stop. Mic-open failure is non-fatal — recording continues
                   loopback-only after emitting a MIC_WARNING.
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
        # When the mic is also enabled, a second transcriber (created below, once
        # the mic format is known) handles the mic stream and the two results are
        # merged at stop (Option B). The loopback transcriber keeps the real
        # output path so a mic failure still leaves a loopback-only transcript.
        transcriber = None
        mic_transcriber = None
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
        # Wall-clock instant the first real (un-paused) frame is written for each
        # source, on a common monotonic clock. The delta aligns the two WAVs at
        # mix time — overlay() otherwise assumes both started at the same instant.
        first_ts = {'loop': None, 'mic': None}

        def callback(in_data, frame_count, time_info, status):
            if status:
                log.warning(f'Audio callback status: {status}')
            if stop_event.is_set():
                return (None, pyaudio.paComplete)
            if not pause_event.is_set():
                if first_ts['loop'] is None:
                    first_ts['loop'] = time.monotonic()
                wf.writeframes(in_data)
                if transcriber:
                    transcriber.send_audio(in_data)
                frames_written[0] += frame_count
            return (None, pyaudio.paContinue)

        # Optional second input stream: the local microphone, written to its own
        # WAV and mixed into the loopback audio at stop. Failure here must never
        # abort the consultation recording — fall back to loopback-only.
        mic_wav_path = None
        mic_wf = None
        mic_stream = None
        mic_frames = [0]
        if mic_enabled:
            try:
                if mic_device_override is not None:
                    mic_index = mic_device_override
                    mic_info = p.get_device_info_by_index(mic_index)
                else:
                    mic_info = p.get_default_input_device_info()
                    mic_index = mic_info['index']
                mic_rate = int(mic_info['defaultSampleRate'])
                mic_channels = min(int(mic_info.get('maxInputChannels', 1) or 1), 2)
                mic_wav_path = output_mp3.replace('.mp3', '_mic.wav')
                mic_wf = wave.open(mic_wav_path, 'wb')
                mic_wf.setnchannels(mic_channels)
                mic_wf.setsampwidth(2)  # 16-bit
                mic_wf.setframerate(mic_rate)

                # Second realtime transcriber for the mic stream (Option B). Its
                # output_path is None — results are merged in memory at stop.
                if realtime_args:
                    mic_transcriber = RealtimeTranscriber(
                        api_key=realtime_args.api_key,
                        output_path=None,
                        sample_rate=mic_rate,
                        channels=mic_channels,
                    )
                    mic_transcriber.start()
                    log.info(f'Mic realtime transcriber started ({mic_rate}Hz, {mic_channels}ch)')

                def mic_callback(in_data, frame_count, time_info, status):
                    if status:
                        log.warning(f'Mic callback status: {status}')
                    if stop_event.is_set():
                        return (None, pyaudio.paComplete)
                    if not pause_event.is_set():
                        if first_ts['mic'] is None:
                            first_ts['mic'] = time.monotonic()
                        mic_wf.writeframes(in_data)
                        if mic_transcriber:
                            mic_transcriber.send_audio(in_data)
                        mic_frames[0] += frame_count
                    return (None, pyaudio.paContinue)

                mic_stream = p.open(
                    format=pyaudio.paInt16,
                    channels=mic_channels,
                    rate=mic_rate,
                    input=True,
                    input_device_index=mic_index,
                    frames_per_buffer=chunk,
                    stream_callback=mic_callback
                )
            except Exception as e:
                log.warning(f'Mic capture unavailable: {e}')
                print(f'MIC_WARNING: microphone unavailable ({e}) — recording call audio only', file=sys.stderr, flush=True)
                if mic_wf:
                    try: mic_wf.close()
                    except Exception: pass
                    mic_wf = None
                mic_stream = None
                mic_wav_path = None

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
        if mic_stream:
            mic_stream.start_stream()
            log.info(f'Mic capture started [{mic_index}]: {mic_info["name"]} at {mic_rate}Hz, {mic_channels}ch')

        while stream.is_active() and not stop_event.is_set():
            stop_event.wait(timeout=0.1)

        stream.stop_stream()
        stream.close()
        wf.close()
        if mic_stream:
            try:
                mic_stream.stop_stream()
                mic_stream.close()
            except Exception:
                pass
        if mic_wf:
            try:
                mic_wf.close()
            except Exception:
                pass

        log.info(f'Recorded {frames_written[0]} frames (mic: {mic_frames[0]}).')

        # Discard path: abandon realtime transcriber (daemon thread dies with
        # the process), delete the temp WAV(s), and exit cleanly with no ERROR output.
        if discard_event and discard_event.is_set():
            if transcriber:
                log.info('Discarding — realtime transcriber abandoned.')
            for p_ in (wav_path, mic_wav_path):
                if not p_:
                    continue
                try:
                    os.remove(p_)
                except OSError:
                    pass
            return

        # Fail only when there is truly no audio from either source.
        if frames_written[0] == 0 and mic_frames[0] == 0:
            log.error('No audio frames captured — wrong loopback device or no system audio playing.')
            # Clean up the empty WAV(s)
            for p_ in (wav_path, mic_wav_path):
                if not p_:
                    continue
                try:
                    os.remove(p_)
                except OSError:
                    pass
            sys.exit(1)

        # Mic start offset on the common monotonic clock (used by both the audio
        # mix and the dual-transcriber merge). Positive → mic started after
        # loopback (pad mic); negative → before (pad loopback).
        mic_offset_ms = 0
        if first_ts['loop'] is not None and first_ts['mic'] is not None:
            mic_offset_ms = int(round((first_ts['mic'] - first_ts['loop']) * 1000))
            log.info(f'Mic start offset vs loopback: {mic_offset_ms}ms')

        # Finalize realtime transcript(s) (drain WS queue, await server final
        # response). Must run after the streams close so no more audio arrives,
        # and before WAV→MP3 so the total wall-time is accurate.
        finalize_realtime_transcripts(transcriber, mic_transcriber, realtime_args, mic_offset_ms)

        duration_seconds = frames_written[0] / sample_rate
        if mic_wav_path and mic_frames[0]:
            duration_seconds = max(duration_seconds, mic_frames[0] / mic_rate)
        print(f'DURATION_SECONDS: {duration_seconds:.3f}', flush=True)

        log.info('Converting to MP3...')
        wav_to_mp3(wav_path, output_mp3, sample_rate, mic_wav_path=mic_wav_path, mic_offset_ms=mic_offset_ms)
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

def record_macos(output_mp3, device_index_override, stop_event, pause_event, realtime_args=None, discard_event=None,
                 mic_enabled=False, mic_device_override=None):
    """
    realtime_args: argparse.Namespace with .api_key and .realtime_output set,
                   or None if realtime transcription is disabled.
    mic_enabled:   when True, open a second input stream on the default (or
                   overridden) microphone and mix it with the loopback audio at
                   stop. Mic-open failure is non-fatal — recording continues
                   loopback-only after emitting a MIC_WARNING.
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

    # Create the realtime transcriber now that we know the device format. When the
    # mic is also enabled a second transcriber (created below) handles the mic and
    # both results are merged at stop (Option B). The loopback transcriber keeps
    # the real output path so a mic failure still leaves a loopback-only transcript.
    transcriber = None
    mic_transcriber = None
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

    # Wall-clock instant the first real (un-paused) frame is written for each
    # source, on a common monotonic clock. The delta aligns the two WAVs at mix
    # time — overlay() otherwise assumes both started at the same instant.
    first_ts = {'loop': None, 'mic': None}

    def callback(indata, frames, time_info, status):
        if status:
            log.warning(f'sounddevice status: {status}')
        # Don't capture frames after stop is requested (parity with the Windows
        # callback's paComplete short-circuit). The InputStream context exit
        # below performs the actual stream teardown.
        if stop_event.is_set():
            return
        if not pause_event.is_set():
            if first_ts['loop'] is None:
                first_ts['loop'] = time.monotonic()
            wav_file.write(indata)
            if transcriber:
                # indata is a numpy int16 array; convert to raw bytes for the WS.
                transcriber.send_audio(indata.tobytes())

    # Optional second input stream: the local microphone, written to its own WAV
    # and mixed into the loopback audio at stop. Failure is non-fatal — fall back
    # to loopback-only.
    mic_wav_path = None
    mic_file = None
    mic_stream = None
    mic_frames = [0]
    mic_rate = sample_rate
    if mic_enabled:
        try:
            if mic_device_override is not None:
                mic_index = mic_device_override
            else:
                mic_index = sd.default.device[0]  # (input, output) pair
            mic_info = sd.query_devices(mic_index)
            mic_rate = int(mic_info.get('default_samplerate') or 48000)
            mic_channels = min(int(mic_info['max_input_channels']), 2) or 1
            mic_wav_path = output_mp3.replace('.mp3', '_mic.wav')
            mic_file = sf.SoundFile(mic_wav_path, mode='w', samplerate=mic_rate,
                                    channels=mic_channels, subtype='PCM_16')

            # Second realtime transcriber for the mic stream (Option B). Its
            # output_path is None — results are merged in memory at stop.
            if realtime_args:
                mic_transcriber = RealtimeTranscriber(
                    api_key=realtime_args.api_key,
                    output_path=None,
                    sample_rate=mic_rate,
                    channels=mic_channels,
                )
                mic_transcriber.start()
                log.info(f'Mic realtime transcriber started ({mic_rate}Hz, {mic_channels}ch)')

            def mic_callback(indata, frames, time_info, status):
                if status:
                    log.warning(f'mic sounddevice status: {status}')
                if stop_event.is_set():
                    return
                if not pause_event.is_set():
                    if first_ts['mic'] is None:
                        first_ts['mic'] = time.monotonic()
                    mic_file.write(indata)
                    if mic_transcriber:
                        mic_transcriber.send_audio(indata.tobytes())
                    mic_frames[0] += frames

            mic_stream = sd.InputStream(
                device=mic_index,
                channels=mic_channels,
                samplerate=mic_rate,
                callback=mic_callback,
                dtype='int16'
            )
            mic_stream.start()
            log.info(f'Mic capture started [{mic_index}]: {mic_info["name"]} at {mic_rate}Hz, {mic_channels}ch')
        except Exception as e:
            log.warning(f'Mic capture unavailable: {e}')
            print(f'MIC_WARNING: microphone unavailable ({e}) — recording call audio only', file=sys.stderr, flush=True)
            if mic_file:
                try: mic_file.close()
                except Exception: pass
                mic_file = None
            mic_stream = None
            mic_wav_path = None
            mic_transcriber = None

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
    if mic_stream:
        try:
            mic_stream.stop()
            mic_stream.close()
        except Exception:
            pass
    if mic_file:
        try:
            mic_file.close()
        except Exception:
            pass

    log.info(f'Recorded {total_frames} frames (mic: {mic_frames[0]}).')

    # Discard path: abandon realtime transcriber, delete temp WAV(s), exit cleanly.
    if discard_event and discard_event.is_set():
        if transcriber:
            log.info('Discarding — realtime transcriber abandoned.')
        for p_ in (wav_path, mic_wav_path):
            if not p_:
                continue
            try:
                os.remove(p_)
            except OSError:
                pass
        return

    # 0-frames guard (parity with Windows): a silent capture means BlackHole
    # isn't receiving system audio. Fail only when neither source captured audio.
    if total_frames == 0 and mic_frames[0] == 0:
        log.error('No audio frames captured — BlackHole is not receiving system audio. '
                  'Check that a Multi-Output Device (including BlackHole) is selected as the system output.')
        for p_ in (wav_path, mic_wav_path):
            if not p_:
                continue
            try:
                os.remove(p_)
            except OSError:
                pass
        sys.exit(1)

    # Mic start offset on the common monotonic clock (used by both the audio mix
    # and the dual-transcriber merge). Positive → mic started after loopback (pad
    # mic); negative → before (pad loopback).
    mic_offset_ms = 0
    if first_ts['loop'] is not None and first_ts['mic'] is not None:
        mic_offset_ms = int(round((first_ts['mic'] - first_ts['loop']) * 1000))
        log.info(f'Mic start offset vs loopback: {mic_offset_ms}ms')

    # Finalize realtime transcript(s) before WAV→MP3 (same reasoning as Windows).
    finalize_realtime_transcripts(transcriber, mic_transcriber, realtime_args, mic_offset_ms)

    duration_seconds = total_frames / sample_rate
    if mic_wav_path and mic_frames[0]:
        duration_seconds = max(duration_seconds, mic_frames[0] / mic_rate)
    print(f'DURATION_SECONDS: {duration_seconds:.3f}', flush=True)

    log.info('Stopped recording. Converting to MP3...')
    wav_to_mp3(wav_path, output_mp3, sample_rate, mic_wav_path=mic_wav_path, mic_offset_ms=mic_offset_ms)
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

def wav_to_mp3(wav_path, mp3_path, original_sample_rate, mic_wav_path=None, mic_offset_ms=0):
    """Convert the loopback WAV to a 16kHz mono MP3 for transcription.

    When mic_wav_path is given and present, the two sources are normalised to
    16kHz mono and layered with overlay(). The two streams do not start at the
    same instant, so mic_offset_ms (mic_start - loop_start, measured on a common
    monotonic clock) is applied first: the later-starting source is padded with
    that much leading silence so the voices line up in real time rather than both
    being pinned to sample 0. The longer of the two is then used as the overlay
    base so nothing is truncated (handles mic-only audio too).

    NOTE: this corrects the constant start skew. It does not compensate for slow
    clock drift between the two hardware devices over very long recordings.
    """
    from pydub import AudioSegment
    try:
        audio = AudioSegment.from_wav(wav_path).set_frame_rate(16000).set_channels(1)

        if mic_wav_path and os.path.exists(mic_wav_path):
            mic_seg = AudioSegment.from_wav(mic_wav_path).set_frame_rate(16000).set_channels(1)
            # Align starts on the common clock. Pad the source that began later.
            if mic_offset_ms > 0:
                mic_seg = AudioSegment.silent(duration=mic_offset_ms, frame_rate=16000) + mic_seg
            elif mic_offset_ms < 0:
                audio = AudioSegment.silent(duration=-mic_offset_ms, frame_rate=16000) + audio
            base, other = (audio, mic_seg) if len(audio) >= len(mic_seg) else (mic_seg, audio)
            audio = base.overlay(other)
            log.info(f'Mixed microphone audio into the recording (offset {mic_offset_ms}ms).')

        os.makedirs(os.path.dirname(mp3_path) or '.', exist_ok=True)
        audio.export(mp3_path, format='mp3')
        os.remove(wav_path)
        log.info(f'WAV deleted: {wav_path}')
        if mic_wav_path and os.path.exists(mic_wav_path):
            os.remove(mic_wav_path)
            log.info(f'Mic WAV deleted: {mic_wav_path}')
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

    if args.mic:
        log.info('Microphone capture enabled — mixing mic + loopback audio')

    if sys.platform == 'win32':
        record_windows(args.output, args.device, stop_event, pause_event,
                       realtime_args=realtime_args, discard_event=discard_event,
                       mic_enabled=args.mic, mic_device_override=args.mic_device)
    elif sys.platform == 'darwin':
        record_macos(args.output, args.device, stop_event, pause_event,
                     realtime_args=realtime_args, discard_event=discard_event,
                     mic_enabled=args.mic, mic_device_override=args.mic_device)
    else:
        print(f'ERROR: Unsupported platform: {sys.platform}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
