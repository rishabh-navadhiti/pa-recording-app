"""Tests for record.py's pure device-matching functions (Phase 5).

These cover the gnarliest, most-likely-to-be-broken logic (the Windows 5-pass
WASAPI loopback heuristic + the macOS capture-device matcher) WITHOUT needing
any audio hardware or platform-specific libs — record.py imports pyaudiowpatch /
sounddevice lazily inside the capture functions, so importing the module is
stdlib-only.

Run: python -m unittest discover -s tests/python
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python'))
import record  # noqa: E402


class SelectLoopbackIndexTest(unittest.TestCase):
    """The Windows 5-pass heuristic, behaviour-preserved from get_loopback_device."""

    def test_pass1_startswith(self):
        lb = [(3, {'name': 'Speakers (Realtek) [Loopback]'}),
              (5, {'name': 'SPDIF Out [Loopback]'})]
        i, dev, reason = record.select_loopback_index(lb, 'Speakers (Realtek)')
        self.assertEqual(i, 3)
        self.assertEqual(reason, 'startswith')

    def test_pass2_substring(self):
        # default name is contained in the loopback name but doesn't start it
        lb = [(7, {'name': 'Digital Output'}),
              (8, {'name': 'USB Audio Realtek HD [Loopback]'})]
        i, dev, reason = record.select_loopback_index(lb, 'Realtek HD')
        self.assertEqual(i, 8)
        self.assertEqual(reason, 'substring')

    def test_pass3_reverse_substring(self):
        # loopback base (minus " [Loopback]") is contained in the default name
        lb = [(1, {'name': 'Speakers [Loopback]'})]
        i, dev, reason = record.select_loopback_index(lb, 'Speakers (Realtek) High Definition Audio')
        self.assertEqual(i, 1)
        self.assertEqual(reason, 'reverse-substring')

    def test_pass4_speaker_type(self):
        lb = [(2, {'name': 'SPDIF Interface'}),
              (4, {'name': 'Headphones Pro [Loopback]'})]
        i, dev, reason = record.select_loopback_index(lb, 'Nonexistent Device')
        self.assertEqual(i, 4)
        self.assertEqual(reason, 'speaker-type')

    def test_pass5_first_available(self):
        lb = [(9, {'name': 'Some Digital Out'}), (10, {'name': 'Another'})]
        i, dev, reason = record.select_loopback_index(lb, 'Nonexistent Device')
        self.assertEqual(i, 9)
        self.assertEqual(reason, 'first-available')

    def test_startswith_wins_over_later_passes(self):
        # device that would match pass-4 (speaker-type) appears first, but a
        # startswith match must still win.
        lb = [(1, {'name': 'Headphones X'}),
              (2, {'name': 'Speakers (Realtek) [Loopback]'})]
        i, dev, reason = record.select_loopback_index(lb, 'Speakers (Realtek)')
        self.assertEqual(reason, 'startswith')
        self.assertEqual(i, 2)

    def test_empty_list(self):
        self.assertEqual(record.select_loopback_index([], 'anything'), (None, None, None))


class SelectMacosInputIndexTest(unittest.TestCase):

    def test_prefers_blackhole_over_mic(self):
        devices = [
            {'name': 'MacBook Pro Microphone', 'max_input_channels': 1},
            {'name': 'BlackHole 2ch', 'max_input_channels': 2},
        ]
        i, dev = record.select_macos_input_index(devices)
        self.assertEqual(i, 1)
        self.assertEqual(dev['name'], 'BlackHole 2ch')

    def test_priority_order_blackhole_before_aggregate(self):
        devices = [
            {'name': 'Aggregate Device', 'max_input_channels': 2},
            {'name': 'BlackHole 16ch', 'max_input_channels': 16},
        ]
        i, dev = record.select_macos_input_index(devices)
        self.assertEqual(dev['name'], 'BlackHole 16ch')

    def test_falls_through_to_aggregate_when_no_blackhole(self):
        devices = [
            {'name': 'Built-in Microphone', 'max_input_channels': 1},
            {'name': 'My Aggregate Device', 'max_input_channels': 2},
        ]
        i, dev = record.select_macos_input_index(devices)
        self.assertEqual(dev['name'], 'My Aggregate Device')

    def test_never_falls_back_to_mic(self):
        # The safety property: an ordinary input (built-in mic) is NOT a fallback.
        devices = [{'name': 'Built-in Microphone', 'max_input_channels': 1}]
        self.assertEqual(record.select_macos_input_index(devices), (None, None))

    def test_skips_candidate_with_no_input_channels(self):
        # A BlackHole *output* leg (0 input channels) must not be picked.
        devices = [{'name': 'BlackHole 2ch', 'max_input_channels': 0}]
        self.assertEqual(record.select_macos_input_index(devices), (None, None))


class IsMacosCaptureCandidateTest(unittest.TestCase):

    def test_mic_is_not_a_candidate(self):
        self.assertFalse(record.is_macos_capture_candidate('MacBook Pro Microphone'))

    def test_known_drivers_match_case_insensitively(self):
        for name in ('BlackHole 16ch', 'blackhole 2ch', 'My Aggregate Device',
                     'Loopback Audio', 'Soundflower (2ch)'):
            self.assertTrue(record.is_macos_capture_candidate(name), name)

    def test_none_or_empty_is_safe(self):
        self.assertFalse(record.is_macos_capture_candidate(None))
        self.assertFalse(record.is_macos_capture_candidate(''))


if __name__ == '__main__':
    unittest.main()
