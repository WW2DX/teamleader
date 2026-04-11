#!/usr/bin/env python3
"""Icom IC-7610 CI-V bridge over LAN using icom-lan library.

Connects to an Icom IC-7610 via its built-in network interface and exposes
the same REST API as FlexBridge (/status, /cat/command) so server.js can
poll and forward commands without knowing the backend.

Requires: pip install icom-lan   (Python ≥ 3.11)
"""

import asyncio
import argparse
import json
import logging
import signal
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

log = logging.getLogger('icom-bridge')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(message)s')

# ── Args ──────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description='Icom CI-V Bridge')
parser.add_argument('--radio', default='10.0.10.112', help='Radio IP address')
parser.add_argument('--port', type=int, default=50001, help='Radio CI-V UDP port')
parser.add_argument('--username', default='', help='Network control username')
parser.add_argument('--password', default='', help='Network control password')
parser.add_argument('--civ-addr', type=lambda x: int(x, 0), default=0x98, help='CI-V address (0x98 for IC-7610)')
parser.add_argument('--status-port', type=int, default=7377, help='REST status API port')
args = parser.parse_args()

# ── State ─────────────────────────────────────────────────────────────────────
state = {
    'connected': False,
    'radio_ip': args.radio,
    'radio_model': 'IC-7610',
    'protocol_version': 'CI-V/LAN',
    'freq_hz': 14074000,
    'tx_freq_hz': 14074000,
    'rx_freq_hz': 14074000,
    'mode': 'USB',
    'split': False,
    'tx_inhibit': False,
}

radio = None  # IcomRadio instance
_loop = None  # asyncio event loop for the radio

# ── Mode mapping ──────────────────────────────────────────────────────────────
ICOM_TO_NAME = {
    'LSB': 'LSB', 'USB': 'USB', 'AM': 'AM', 'CW': 'CW', 'RTTY': 'RTTY',
    'FM': 'FM', 'CW_R': 'CW', 'RTTY_R': 'RTTY', 'PSK': 'DIGU',
    'lsb': 'LSB', 'usb': 'USB', 'am': 'AM', 'cw': 'CW', 'fm': 'FM',
}
TS2K_TO_MODE = {'1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM', '6': 'RTTY', '9': 'USB'}
MODE_TO_TS2K = {'LSB': '1', 'USB': '2', 'CW': '3', 'FM': '4', 'AM': '5', 'RTTY': '6', 'DIGU': '9', 'DIGL': '9'}


def normalise_mode(m):
    s = str(m).upper().replace('-', '_')
    return ICOM_TO_NAME.get(s, ICOM_TO_NAME.get(str(m), 'USB'))


# ── Async radio connection ────────────────────────────────────────────────────
async def radio_loop():
    global radio
    from icom_lan import create_radio, LanBackendConfig

    config = LanBackendConfig(
        host=args.radio,
        port=args.port,
        username=args.username,
        password=args.password,
        radio_addr=args.civ_addr,
    )

    while True:
        try:
            log.info(f'Connecting to {args.radio}:{args.port}...')
            radio = create_radio(config)
            await radio.connect()
            state['connected'] = True
            log.info('Connected to IC-7610!')

            # Poll loop
            while state['connected']:
                try:
                    freq = await radio.get_freq(bypass_cache=True)
                    mode_info = await radio.get_mode()
                    mode_name = normalise_mode(mode_info[0]) if mode_info else state['mode']

                    state['freq_hz'] = freq
                    state['tx_freq_hz'] = freq
                    state['rx_freq_hz'] = freq
                    state['mode'] = mode_name
                except Exception as e:
                    log.warning(f'Poll error: {e}')
                    break

                await asyncio.sleep(0.4)

        except Exception as e:
            log.warning(f'Connection error: {e}')
            state['connected'] = False
            radio = None

        state['connected'] = False
        log.info('Disconnected — reconnecting in 5s')
        await asyncio.sleep(5)


def _run_radio_loop():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.run_until_complete(radio_loop())


# ── CAT command handler ───────────────────────────────────────────────────────
def handle_cat(cmd):
    cmd = cmd.strip().upper().rstrip(';')
    if not cmd:
        return ''

    # FA — frequency
    if cmd.startswith('FA'):
        if len(cmd) > 2:
            try:
                hz = int(cmd[2:])
                state['freq_hz'] = hz
                state['tx_freq_hz'] = hz
                if state['connected'] and radio and _loop:
                    asyncio.run_coroutine_threadsafe(radio.set_freq(hz), _loop)
                    log.info(f'Set freq: {hz} Hz')
            except ValueError:
                pass
            return ''
        return f'FA{state["freq_hz"]:011d};'

    # MD — mode
    if cmd.startswith('MD'):
        if len(cmd) > 2:
            mode = TS2K_TO_MODE.get(cmd[2], 'USB')
            state['mode'] = mode
            if state['connected'] and radio and _loop:
                asyncio.run_coroutine_threadsafe(radio.set_mode(mode), _loop)
                log.info(f'Set mode: {mode}')
            return ''
        return f'MD{MODE_TO_TS2K.get(state["mode"], "2")};'

    # IF — transceiver info
    if cmd == 'IF':
        freq = f'{state["freq_hz"]:011d}'
        mode = MODE_TO_TS2K.get(state['mode'], '2')
        split = '1' if state['split'] else '0'
        return f'IF{freq}     +0000000000{mode}00{split}0000;'

    if cmd == 'ID': return 'ID020;'
    if cmd.startswith('AI'): return 'AI0;'

    # TX inhibit for band conflict
    if cmd == 'TX0':
        state['tx_inhibit'] = True
        log.warning('TX INHIBITED (band conflict)')
        return ''
    if cmd == 'TX1':
        state['tx_inhibit'] = False
        log.info('TX inhibit released')
        return ''

    if cmd in ('TX', 'RX'): return ''
    if cmd == 'PS': return 'PS1;'
    return '?;'


# ── REST API ──────────────────────────────────────────────────────────────────
class BridgeAPI(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/status':
            self._send(200, {
                'connected': state['connected'],
                'radio_ip': state['radio_ip'],
                'radio_model': state['radio_model'],
                'protocol_version': state['protocol_version'],
                'freq_hz': state['freq_hz'],
                'tx_freq_hz': state['tx_freq_hz'],
                'rx_freq_hz': state['rx_freq_hz'],
                'mode': state['mode'],
                'split': state['split'],
                'tx_inhibit': state['tx_inhibit'],
            })
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get('Content-Length', 0))
        body = {}
        if length:
            try:
                body = json.loads(self.rfile.read(length))
            except Exception:
                pass

        if path == '/cat/command':
            cmd = body.get('command', '').strip()
            if not cmd:
                self._send(400, {'ok': False, 'error': 'No command'})
                return
            resp = handle_cat(cmd)
            self._send(200, {'ok': True, 'response': resp})
        else:
            self._send(404, {'error': 'not found'})


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    # Start REST API
    srv = ThreadedHTTPServer(('127.0.0.1', args.status_port), BridgeAPI)
    api_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    api_thread.start()
    log.info(f'REST API on http://127.0.0.1:{args.status_port}')

    # Start radio connection in background thread
    radio_thread = threading.Thread(target=_run_radio_loop, daemon=True)
    radio_thread.start()
    log.info(f'Connecting to IC-7610 at {args.radio}:{args.port}')

    # Wait for shutdown
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info('Shutting down')
        srv.shutdown()


if __name__ == '__main__':
    main()
