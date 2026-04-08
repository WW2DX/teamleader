#!/usr/bin/env python3
"""
FlexBridge — FlexRadio 6000 series CAT bridge for Team Leader
Connects to SmartSDR API, exposes:
  - Virtual serial port (PTY) for CAT control
  - TCP CAT server (rigctld-compatible subset)
  - REST API on port 7376 for status / control from the settings UI
"""

import asyncio
import argparse
import json
import logging
import os
import pty
import re
import select
import socket
import struct
import sys
import termios
import threading
import time
import tty
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    format='%(asctime)s [FlexBridge] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
    stream=sys.stdout,
)
log = logging.getLogger('flexbridge')

# ── Argument parsing ───────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description='FlexBridge — FlexRadio CAT bridge')
parser.add_argument('--radio',       default='',    help='FlexRadio IP (blank = auto-discover)')
parser.add_argument('--cat-port',    type=int, default=4532, help='TCP CAT port (default 4532)')
parser.add_argument('--dax-channels', default='1',  help='Comma-separated DAX channel numbers')
parser.add_argument('--status-port', type=int, default=7376, help='REST status API port')
parser.add_argument('--cat-slice',   type=int, default=0,    help='Slice index for CAT (0=A)')
args = parser.parse_args()

DAX_CHANNELS = [int(c.strip()) for c in args.dax_channels.split(',') if c.strip()]
PTY_SYMLINK   = '/tmp/flexbridge_ttyCAT0'
FLEX_API_PORT = 4992   # SmartSDR TCP API port

# ── Shared state ───────────────────────────────────────────────────────────────
state = {
    'connected':        False,
    'radio_ip':         None,
    'protocol_version': None,
    'freq_hz':          14225000,
    'mode':             'USB',
    'rx_freq_hz':       14225000,
    'tx_freq_hz':       14225000,
    'split':            False,
    'slice':            args.cat_slice,
    'cwx_speed':        25,
    'cat': {
        'serial_symlink': PTY_SYMLINK,
        'tcp_port':       args.cat_port,
    },
    'dax': {ch: {'rx_packets': 0} for ch in DAX_CHANNELS},
    'radios_on_lan':    [],
}

# ── SmartSDR API connection ────────────────────────────────────────────────────
def _get_local_ip():
    """Get the local machine's primary IP address."""
    try:
        sock2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock2.connect(('8.8.8.8', 80))
        ip = sock2.getsockname()[0]
        sock2.close()
        return ip
    except Exception:
        return None


class SmartSDR:
    def __init__(self):
        self.sock      = None
        self.seq       = 1
        self.handlers  = {}
        self._lock     = threading.Lock()
        self._running  = False
        self._thread   = None
        self._handle   = None   # assigned by SmartSDR on connect (H<hex>)

    def connect(self, ip):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(5)
            s.connect((ip, FLEX_API_PORT))
            s.settimeout(None)
            self.sock    = s
            self._running = True
            self._thread = threading.Thread(target=self._reader, daemon=True)
            self._thread.start()
            log.info(f'Connected to SmartSDR at {ip}:{FLEX_API_PORT}')
            state['connected'] = True
            state['radio_ip']  = ip
            return True
        except Exception as e:
            log.warning(f'SmartSDR connect failed: {e}')
            return False

    def _register(self):
        """Register as a client after receiving handle — required for slice commands."""
        # Use the UDP-trick to get the real LAN IP (not 127.0.0.1)
        local_ip = _get_local_ip() or '127.0.0.1'
        self.cmd(f'client ip {local_ip}')
        self.cmd('sub slice all')
        self.cmd('sub radio all')
        # Note: 'sub cwx' is rejected in SmartSDR v1.4 (error 50000016)
        log.info(f'[SmartSDR] Client registered (ip={local_ip}), subscribed to slice/radio')

    def disconnect(self):
        self._running = False
        state['connected'] = False
        if self.sock:
            try: self.sock.close()
            except: pass
            self.sock = None

    def cmd(self, command):
        """Send a command and return the sequence number."""
        if not self.sock:
            return None
        with self._lock:
            seq = self.seq
            self.seq += 1
            line = f'C{seq}|{command}\n'
            log.debug(f'[SmartSDR TX] {line.strip()}')
            try:
                self.sock.sendall(line.encode())
            except Exception as e:
                log.warning(f'Send failed: {e}')
                self.disconnect()
                return None
        return seq

    def set_freq(self, freq_hz):
        global _last_set_time
        sl = state['slice']
        freq_mhz = freq_hz / 1_000_000
        # SmartSDR API: use 'slice tune' to change frequency, NOT 'slice set RF_frequency'
        # 'slice set RF_frequency' is read-only reflected state; 'slice tune' is the write command
        cmd = f'slice tune {sl} {freq_mhz:.6f} autopan=1'
        log.info(f'set_freq: {freq_hz} Hz → {cmd}  (radio={state["radio_ip"]})')
        self.cmd(cmd)
        state['freq_hz']    = freq_hz
        state['tx_freq_hz'] = freq_hz
        _last_set_time = _time.monotonic()  # hold off status overwrites briefly

    def set_mode(self, mode):
        global _last_set_time
        """mode: USB/LSB/CW/FM/AM/DIGU/DIGL"""
        sl = state['slice']
        cmd = f'slice set {sl} mode={mode}'
        log.info(f'set_mode: {mode} → {cmd}  (radio={state["radio_ip"]})')
        self.cmd(cmd)
        state['mode'] = mode
        _last_set_time = _time.monotonic()

    def cwx_send(self, text):
        """Send text via SmartSDR CWX keyer."""
        safe = text.replace('"', '')
        self.cmd(f'cwx send "{safe}"')
        log.info(f'cwx send: {safe!r}')

    def cwx_clear(self):
        """Clear the CWX send queue."""
        self.cmd('cwx clear')
        log.info('cwx clear')

    def cwx_set_speed(self, wpm):
        """Set CW keyer speed in WPM.
        Official SmartSDR TCP API: cwx wpm <n>  (FlexRadio community doc)
        """
        w = int(wpm)
        self.cmd(f'cwx wpm {w}')
        log.info(f'cwx speed → {w} wpm')

    def _reader(self):
        buf = b''
        while self._running and self.sock:
            try:
                data = self.sock.recv(4096)
                if not data:
                    break
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    self._parse(line.decode('utf-8', errors='replace').strip())
            except Exception as e:
                if self._running:
                    log.warning(f'Reader error: {e}')
                break
        log.info('SmartSDR reader stopped')
        state['connected'] = False

    def _parse(self, line):
        """Parse SmartSDR API response lines."""
        if not line:
            return
        # Log everything SmartSDR sends so we can see rejections
        log.debug(f'[SmartSDR RX] {line}')
        # Handle assignment: H<handle> — server assigns us a client handle on connect
        m = re.match(r'^H([0-9A-Fa-f]+)$', line)
        if m:
            self._handle = m.group(1)
            log.info(f'[SmartSDR] Client handle: {self._handle}')
            # Now we have a handle — register and subscribe
            self._register()
            return
        # Command response: R<seq>|<error_code>|<message>
        m = re.match(r'^R(\d+)\|(\d+)\|(.*)$', line)
        if m:
            seq, err, msg_text = m.group(1), m.group(2), m.group(3)
            if err != '0':
                log.warning(f'[SmartSDR] Command {seq} REJECTED error {err}: {msg_text}')
            else:
                log.info(f'[SmartSDR] Command {seq} OK: {msg_text}')
                # Capture stream IDs from 'stream create' responses
                if seq in self.handlers:
                    self.handlers[seq](msg_text)
                    del self.handlers[seq]
            return
        # Status message: S<handle>|<object> <k=v ...>
        m = re.match(r'^S[0-9A-Fa-f]+\|(.+)$', line)
        if m:
            self._handle_status(m.group(1))
            return
        # Version message: V<version>
        m = re.match(r'^V(.+)$', line)
        if m:
            state['protocol_version'] = m.group(1).strip()
            log.info(f'[SmartSDR] Protocol version: {state["protocol_version"]}')

    def _handle_status(self, body):
        # slice N k=v k=v ...
        m = re.match(r'^slice (\d+) (.+)$', body)
        if m:
            sl_idx = int(m.group(1))
            if sl_idx != state['slice']:
                return
            pairs = re.findall(r'(\w+)=(\S+)', m.group(2))
            # Don't let incoming status overwrite state right after we sent a command
            in_holdoff = (_time.monotonic() - _last_set_time) < _HOLDOFF_SECS
            for k, v in pairs:
                if k == 'RF_frequency' and not in_holdoff:
                    try:
                        hz = round(float(v) * 1_000_000)
                        state['freq_hz']    = hz
                        state['tx_freq_hz'] = hz
                        state['rx_freq_hz'] = hz
                    except ValueError:
                        pass
                elif k == 'mode' and not in_holdoff:
                    state['mode'] = v.upper()
            return
        # dax_audio_stream / audio_stream status — track stream IDs
        m = re.match(r'^audio_stream (\S+) (.+)$', body)
        if m:
            pairs = dict(re.findall(r'(\w+)=(\S+)', m.group(2)))
            dax_ch = int(pairs.get('dax_channel', 0))
            if dax_ch in DAX_CHANNELS:
                stype = pairs.get('type', '')
                try:
                    sid = int(m.group(1), 16)
                except ValueError:
                    return
                if 'rx' in stype.lower():
                    _dax_rx_streams[dax_ch] = {'stream_id': sid}
                    log.info(f'[DAX] RX stream status: ch={dax_ch} stream_id=0x{sid:08X}')
                elif 'tx' in stype.lower():
                    _dax_tx_streams[dax_ch] = {'stream_id': sid}
                    log.info(f'[DAX] TX stream status: ch={dax_ch} stream_id=0x{sid:08X}')


radio = SmartSDR()

# ── LAN discovery (SmartSDR multicast) ────────────────────────────────────────
# SmartSDR radios continuously broadcast status packets to the multicast group
# 239.255.255.250:4992. We join the group and listen for these packets.
# The discovery payload format is key=value pairs separated by spaces.

import time as _time

# Timestamp of last SET command — suppress status overwrite for 1 second after
_last_set_time = 0
_HOLDOFF_SECS  = 1.5
SMARTSDR_MCAST_GROUP = '239.255.255.250'
SMARTSDR_MCAST_PORT  = 4992


def discover_radios(timeout=3.0):
    """Listen on SmartSDR multicast group, then fall back to subnet TCP probe."""
    radios = []
    seen_ips = set()
    mreq = None
    sock = None

    # ── Method 1: Multicast listener ──────────────────────────────────────────
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except AttributeError:
            pass
        sock.bind(('', SMARTSDR_MCAST_PORT))
        mreq = struct.pack('4sL', socket.inet_aton(SMARTSDR_MCAST_GROUP), socket.INADDR_ANY)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        sock.settimeout(0.3)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
                ip = addr[0]
                if ip in seen_ips:
                    continue
                text = data.decode('utf-8', errors='replace').strip()
                if _looks_like_smartsdr(text):
                    seen_ips.add(ip)
                    info = _parse_discovery(text, ip)
                    radios.append(info)
                    log.info(f'Discovered via multicast: {info["model"]} at {ip}')
            except socket.timeout:
                continue
            except Exception as e:
                log.debug(f'Multicast recv: {e}')
                break
    except PermissionError:
        log.warning('Multicast: permission denied — falling back to subnet scan')
    except Exception as e:
        log.debug(f'Multicast error: {e}')
    finally:
        if sock:
            try:
                if mreq:
                    sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, mreq)
                sock.close()
            except Exception:
                pass

    # ── Method 2: TCP probe of local subnet ────────────────────────────────────
    if not radios:
        my_ip = _get_local_ip()
        if my_ip and not my_ip.startswith('127.'):
            subnet = '.'.join(my_ip.split('.')[:3])
            log.info(f'Scanning {subnet}.1-254 on port {FLEX_API_PORT}...')
            found = []
            lock2 = threading.Lock()

            def _probe(ip):
                try:
                    ps = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    ps.settimeout(0.5)
                    if ps.connect_ex((ip, FLEX_API_PORT)) != 0:
                        ps.close()
                        return
                    # Read the SmartSDR banner — it sends V<version> then H<handle>
                    # and status lines immediately on connect
                    ps.settimeout(1.2)
                    banner = b''
                    try:
                        deadline2 = time.time() + 1.0
                        while time.time() < deadline2 and len(banner) < 8192:
                            try:
                                chunk = ps.recv(1024)
                                if not chunk:
                                    break
                                banner += chunk
                            except Exception:
                                break
                    except Exception:
                        pass
                    ps.close()
                    # Parse banner for model/version info
                    text = banner.decode('utf-8', errors='replace')
                    model = 'FlexRadio'
                    version = ''
                    # V line: SmartSDR version e.g. V1.4.0.0 — may be first line (no preceding \n)
                    vm = re.search(r'(?:^|\n)V([0-9][^\r\n]+)', text)
                    if vm:
                        version = vm.group(1).strip()
                    # Status lines contain model=FLEX-6600 / model=FLEX-6400M etc.
                    mm = re.search(r'model=([A-Za-z0-9_\-]+)', text)
                    if mm:
                        model = mm.group(1)
                    # Also try nickname
                    nm = re.search(r'nickname=([^\s]+)', text)
                    if nm and not mm:
                        model = nm.group(1)
                    with lock2:
                        if ip not in seen_ips:
                            seen_ips.add(ip)
                            nickname = model if model != 'FlexRadio' else ip
                            found.append({'ip': ip, 'model': model,
                                          'version': version, 'nickname': nickname,
                                          'callsign': '', 'reachable': True})
                            log.info(f'Discovered via probe: {ip} ({model} {version})')
                except Exception:
                    pass

            threads = [threading.Thread(target=_probe, args=(f'{subnet}.{i}',), daemon=True)
                       for i in range(1, 255)]
            for t in threads: t.start()
            for t in threads: t.join(timeout=0.5)
            radios.extend(found)

    state['radios_on_lan'] = radios
    return radios


def _looks_like_smartsdr(text):
    """Return True if this UDP payload looks like a SmartSDR discovery packet."""
    # SmartSDR packets contain key=value pairs with known SmartSDR fields
    smartsdr_keys = {'model', 'version', 'serial', 'callsign', 'nickname',
                     'inuse_ip', 'inuse_host', 'max_licensed_version',
                     'radio_license_id', 'requires_additional_license'}
    found = set()
    for pair in re.findall(r'(\w+)=', text):
        found.add(pair.lower())
    return bool(found & smartsdr_keys)


def _probe_known_radios(radios, seen_ips):
    """Directly probe port 4992 on discovered IPs to verify they're alive."""
    # For each discovered radio, do a quick TCP check to confirm SmartSDR is responding
    for r in radios:
        ip = r['ip']
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1.0)
            result = s.connect_ex((ip, FLEX_API_PORT))
            s.close()
            r['reachable'] = (result == 0)
        except Exception:
            r['reachable'] = False


def _parse_discovery(text, ip):
    """Parse SmartSDR discovery packet into a radio info dict."""
    info = {
        'ip':        ip,
        'model':     'FlexRadio',
        'version':   '',
        'nickname':  '',
        'callsign':  '',
        'serial':    '',
        'reachable': True,
    }
    try:
        for pair in re.findall(r'(\w+)=([\S]+)', text):
            k, v = pair[0].lower(), pair[1]
            if k == 'model':       info['model']     = v
            elif k == 'version':   info['version']   = v
            elif k == 'nickname':  info['nickname']   = v
            elif k == 'callsign':  info['callsign']   = v
            elif k == 'serial':    info['serial']     = v
    except Exception:
        pass
    # Build a friendly display name
    if not info['nickname'] and info['model']:
        info['nickname'] = info['model']
    return info

# Start background discovery loop — longer first scan, then periodic refresh
def _discovery_loop():
    log.info('Starting radio discovery...')
    # Initial scan: try multicast first, then subnet probe if nothing found
    discover_radios(timeout=5.0)
    if state['radios_on_lan']:
        log.info(f'Found {len(state["radios_on_lan"])} radio(s) on LAN')
    else:
        log.info('No radios found — enter IP manually or click Rescan')
    # After initial scan, only do lightweight multicast refresh every 60s
    # Do NOT repeat the subnet probe — it floods the network
    while True:
        time.sleep(60)
        _multicast_only_refresh(timeout=3.0)

def _multicast_only_refresh(timeout=3.0):
    """Quick multicast-only refresh — no subnet scanning."""
    radios = list(state['radios_on_lan'])  # keep existing probe results
    seen_ips = {r['ip'] for r in radios}
    sock = None
    mreq = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except AttributeError: pass
        sock.bind(('', SMARTSDR_MCAST_PORT))
        mreq = struct.pack('4sL', socket.inet_aton(SMARTSDR_MCAST_GROUP), socket.INADDR_ANY)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        sock.settimeout(0.3)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
                ip = addr[0]
                if ip not in seen_ips:
                    text = data.decode('utf-8', errors='replace').strip()
                    if _looks_like_smartsdr(text):
                        seen_ips.add(ip)
                        info = _parse_discovery(text, ip)
                        radios.append(info)
                        log.info(f'Discovered via multicast: {info["model"]} at {ip}')
            except socket.timeout: continue
            except Exception: break
    except Exception: pass
    finally:
        if sock:
            try:
                if mreq: sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, mreq)
                sock.close()
            except Exception: pass
    state['radios_on_lan'] = radios

threading.Thread(target=_discovery_loop, daemon=True).start()  # noqa — kept at module level for import safety

# ── CAT command parser (Kenwood TS-2000 subset) ────────────────────────────────
def handle_cat(cmd):
    """Parse a CAT command string, return response string."""
    cmd = cmd.strip().upper().rstrip(';')
    if not cmd:
        return ''

    # FA — VFO-A frequency
    if cmd.startswith('FA'):
        if len(cmd) > 2:
            try:
                hz = int(cmd[2:])
                state['freq_hz'] = hz
                state['tx_freq_hz'] = hz
                if state['connected']:
                    radio.set_freq(hz)
            except ValueError:
                pass
            return ''
        else:
            return f'FA{state["freq_hz"]:011d};'

    # FB — VFO-B / RX freq
    if cmd.startswith('FB'):
        if len(cmd) > 2:
            try:
                hz = int(cmd[2:])
                state['rx_freq_hz'] = hz
            except ValueError:
                pass
            return ''
        else:
            return f'FB{state["rx_freq_hz"]:011d};'

    # IF — transceiver info (comprehensive status)
    # TS-2000 IF format (37 chars excl ';', 38 total):
    # IF [freq 11] [step 5] [rit±ofs 5] [rit 1] [xit 1] [bank 1] [ch 2] [tx 1]
    #    [mode 1] [fn 1] [scan 1] [split 1] [tone 1] [tone# 2] [shift 1] ;
    if cmd == 'IF':
        freq  = f'{state["freq_hz"]:011d}'
        mode  = _mode_to_ts2000(state['mode'])
        split = '1' if state.get('split') else '0'
        return f'IF{freq}     +0000000000{mode}00{split}0000;'

    # MD — mode
    if cmd.startswith('MD'):
        if len(cmd) > 2:
            mode = _ts2000_to_mode(cmd[2])
            state['mode'] = mode
            if state['connected']:
                radio.set_mode(mode)
            return ''
        else:
            return f'MD{_mode_to_ts2000(state["mode"])};'

    # ID — radio ID
    if cmd == 'ID':
        return 'ID020;'  # TS-2000

    # AI — auto information
    if cmd.startswith('AI'):
        return 'AI0;'

    # TX / RX
    if cmd == 'TX': return ''
    if cmd == 'RX': return ''

    # PS — power status
    if cmd == 'PS': return 'PS1;'

    # Unrecognised — return error
    return '?;'

def _mode_to_ts2000(mode):
    return {'LSB':'1','USB':'2','CW':'3','FM':'4','AM':'5',
            'FSK':'6','CW-R':'7','DIGU':'9','DIGL':'9'}.get(mode, '2')

def _ts2000_to_mode(code):
    return {'1':'LSB','2':'USB','3':'CW','4':'FM','5':'AM',
            '6':'FSK','9':'DIGU'}.get(code, 'USB')


# ── Hamlib rigctld protocol handler ───────────────────────────────────────────
# WSJT-X (and other hamlib clients) connect via TCP and send newline-terminated
# commands in the rigctld text protocol, NOT Kenwood TS-2000 protocol.

_RIGCTLD_MODE_TO_FLEX = {
    'USB': 'USB', 'LSB': 'LSB', 'CW': 'CW', 'CWR': 'CW-R',
    'FM': 'FM', 'AM': 'AM', 'RTTY': 'FSK', 'RTTYR': 'FSK',
    'PKTUSB': 'DIGU', 'PKTLSB': 'DIGL',
}
_FLEX_MODE_TO_RIGCTLD = {v: k for k, v in _RIGCTLD_MODE_TO_FLEX.items()}
_FLEX_MODE_TO_RIGCTLD.update({'DIGU': 'PKTUSB', 'DIGL': 'PKTLSB', 'CW-R': 'CWR'})

def handle_rigctld(line):
    """Parse a rigctld-protocol command, return response string (newline-terminated)."""
    line = line.strip()
    if not line:
        return ''

    # \dump_state — WSJT-X sends this first to query rig capabilities
    if line == '\\dump_state' or line == '+\\dump_state':
        return (
            '1\n'               # protocol version
            '214\n'             # rig model (TS-2000)
            '2\n'               # ITU region
            # freq range: rxLow rxHigh modes low_power high_power vfo ant
            '30000 60000000 0xef -1 -1 0x1 0x0\n'
            '0 0 0 0 0 0 0\n'  # end of rx range
            '30000 60000000 0xef 5000 100000 0x1 0x0\n'
            '0 0 0 0 0 0 0\n'  # end of tx range
            '0 0\n'            # end of tuning steps
            '0 0\n'            # end of filters
            '0\n'              # max rit
            '0\n'              # max xit
            '0\n'              # max ifshift
            '0\n'              # announces
            '\n'               # preamp
            '\n'               # attenuator
            '0x0\n'            # has get_func
            '0x0\n'            # has set_func
            '0x0\n'            # has get_level
            '0x0\n'            # has set_level
            '0x0\n'            # has get_parm
            '0x0\n'            # has set_parm
            '\n'               # end
        )

    # Handle extended response prefix (+)
    extended = line.startswith('+')
    if extended:
        line = line[1:]

    parts = line.split()
    verb = parts[0] if parts else ''

    # f / \get_freq — get frequency
    if verb in ('f', '\\get_freq'):
        freq = state['freq_hz']
        if extended:
            return f'get_freq: {freq}\n'
        return f'{freq}\n'

    # F / \set_freq <freq> — set frequency
    if verb in ('F', '\\set_freq'):
        if len(parts) >= 2:
            try:
                hz = int(float(parts[1]))
                state['freq_hz'] = hz
                state['tx_freq_hz'] = hz
                if state['connected']:
                    radio.set_freq(hz)
            except ValueError:
                return 'RPRT -1\n'
        return 'RPRT 0\n'

    # m / \get_mode — get mode and passband
    if verb in ('m', '\\get_mode'):
        m = _FLEX_MODE_TO_RIGCTLD.get(state['mode'], 'USB')
        if extended:
            return f'get_mode: {m}\nPassband: 3000\n'
        return f'{m}\n3000\n'

    # M / \set_mode <mode> <passband> — set mode
    if verb in ('M', '\\set_mode'):
        if len(parts) >= 2:
            rigctld_mode = parts[1].upper()
            flex_mode = _RIGCTLD_MODE_TO_FLEX.get(rigctld_mode, None)
            if flex_mode:
                state['mode'] = flex_mode
                if state['connected']:
                    radio.set_mode(flex_mode)
        return 'RPRT 0\n'

    # t / \get_ptt — get PTT state
    if verb in ('t', '\\get_ptt'):
        if extended:
            return 'get_ptt: 0\n'
        return '0\n'

    # T / \set_ptt <0|1>
    if verb in ('T', '\\set_ptt'):
        return 'RPRT 0\n'

    # v / \get_vfo — get current VFO
    if verb in ('v', '\\get_vfo'):
        if extended:
            return 'get_vfo: VFOA\n'
        return 'VFOA\n'

    # V / \set_vfo
    if verb in ('V', '\\set_vfo'):
        return 'RPRT 0\n'

    # s / \get_split_vfo — get split state
    if verb in ('s', '\\get_split_vfo'):
        sp = '1' if state['split'] else '0'
        if extended:
            return f'get_split_vfo: {sp}\nTX VFO: VFOB\n'
        return f'{sp}\nVFOB\n'

    # i / \get_split_freq — get split TX freq
    if verb in ('i', '\\get_split_freq'):
        freq = state['tx_freq_hz']
        if extended:
            return f'get_split_freq: {freq}\n'
        return f'{freq}\n'

    # q / \quit — close connection
    if verb in ('q', '\\quit'):
        return None  # signal to close

    # chk_vfo — some hamlib clients probe this
    if verb == '\\chk_vfo':
        return 'CHKVFO 0\n'

    # Unrecognised
    return 'RPRT -1\n'

# ── PTY virtual serial port ────────────────────────────────────────────────────
def start_pty_server():
    """Create a PTY pair and expose it via a symlink. Reads CAT commands from master side."""
    master_fd, slave_fd = pty.openpty()
    slave_path = os.ttyname(slave_fd)

    # Set raw mode on slave
    try:
        tty.setraw(slave_fd)
    except Exception:
        pass

    # Create symlink
    try:
        if os.path.lexists(PTY_SYMLINK):
            os.unlink(PTY_SYMLINK)
        os.symlink(slave_path, PTY_SYMLINK)
        log.info(f'PTY serial port: {PTY_SYMLINK} → {slave_path}')
    except Exception as e:
        log.warning(f'Could not create PTY symlink: {e}')

    state['cat']['serial_symlink'] = PTY_SYMLINK

    def _pty_reader():
        buf = ''
        while True:
            try:
                r, _, _ = select.select([master_fd], [], [], 1.0)
                if not r:
                    continue
                data = os.read(master_fd, 256).decode('ascii', errors='replace')
                buf += data
                while ';' in buf:
                    cmd, buf = buf.split(';', 1)
                    resp = handle_cat(cmd + ';')
                    if resp:
                        try:
                            os.write(master_fd, resp.encode())
                        except OSError:
                            pass
            except Exception as e:
                log.debug(f'PTY reader: {e}')
                time.sleep(0.5)

    threading.Thread(target=_pty_reader, daemon=True).start()

# ── TCP CAT server ─────────────────────────────────────────────────────────────
def start_tcp_cat_server():
    """TCP server on args.cat_port accepting CAT commands.
    Auto-detects protocol: Kenwood TS-2000 (;-delimited) or hamlib rigctld (newline-delimited).
    WSJT-X uses the rigctld protocol when connecting via TCP.
    """
    def _handle_client(conn, addr):
        log.info(f'CAT TCP client connected: {addr}')
        buf = ''
        protocol = None  # 'kenwood' or 'rigctld', auto-detected on first data
        try:
            while True:
                data = conn.recv(256)
                if not data:
                    break
                buf += data.decode('ascii', errors='replace')

                # Auto-detect protocol from first received data
                if protocol is None and buf.strip():
                    if ';' in buf:
                        protocol = 'kenwood'
                        log.info(f'CAT TCP {addr}: detected Kenwood TS-2000 protocol')
                    elif '\n' in buf:
                        protocol = 'rigctld'
                        log.info(f'CAT TCP {addr}: detected hamlib rigctld protocol')
                    else:
                        continue  # wait for more data to detect delimiter

                if protocol == 'kenwood':
                    while ';' in buf:
                        cmd, buf = buf.split(';', 1)
                        resp = handle_cat(cmd + ';')
                        if resp:
                            conn.sendall(resp.encode())
                else:
                    while '\n' in buf:
                        line, buf = buf.split('\n', 1)
                        resp = handle_rigctld(line)
                        if resp is None:
                            return  # quit command
                        if resp:
                            conn.sendall(resp.encode())
        except Exception:
            pass
        finally:
            conn.close()
            log.info(f'CAT TCP client disconnected: {addr}')

    def _server():
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('0.0.0.0', args.cat_port))
        srv.listen(5)
        log.info(f'CAT TCP server listening on port {args.cat_port}')
        while True:
            try:
                conn, addr = srv.accept()
                threading.Thread(target=_handle_client, args=(conn, addr), daemon=True).start()
            except Exception as e:
                log.warning(f'TCP server error: {e}')

    threading.Thread(target=_server, daemon=True).start()

# ── REST API server ────────────────────────────────────────────────────────────
class FlexBridgeAPI(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass  # silence access log

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
            # Return a clean dict — don't include radios_on_lan (fetched separately)
            status = {
                'connected':        bool(state['connected']),
                'radio_ip':         state['radio_ip'],
                'protocol_version': state['protocol_version'],
                'freq_hz':          state['freq_hz'],
                'tx_freq_hz':       state['tx_freq_hz'],
                'rx_freq_hz':       state['rx_freq_hz'],
                'mode':             state['mode'],
                'split':            state['split'],
                'slice':            state['slice'],
                'cat':              state['cat'],
                'dax':              {str(k): v for k, v in state['dax'].items()},
            }
            self._send(200, status)

        elif path == '/radios':
            self._send(200, state['radios_on_lan'])

        elif path == '/radios/rescan':
            # Kick off a fresh scan in a background thread, return current list immediately
            threading.Thread(target=lambda: discover_radios(timeout=4.0), daemon=True).start()
            self._send(200, {'ok': True, 'message': 'Scan started', 'current': state['radios_on_lan']})

        elif path == '/dax/stats':
            self._send(200, {
                'dax': state['dax'],
                'rx_streams': {str(k): {'stream_id': hex(v['stream_id'])} for k, v in _dax_rx_streams.items()},
                'tx_streams': {str(k): {'stream_id': hex(v['stream_id'])} for k, v in _dax_tx_streams.items()},
                'audio_device': 'BlackHole 2ch' if _dax_running else None,
                'running': _dax_running,
            })

        elif path == '/dax/setup':
            # Manually trigger DAX stream setup (useful if radio was already connected)
            if not state['connected']:
                self._send(400, {'ok': False, 'error': 'Radio not connected'})
            else:
                threading.Thread(target=setup_dax_streams, daemon=True).start()
                self._send(200, {'ok': True, 'message': 'DAX stream setup initiated'})

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

        if path == '/radio/connect':
            ip = body.get('ip', '').strip()
            if not ip:
                self._send(400, {'ok': False, 'error': 'No radio IP specified — click a radio in the list to select it, then click Connect'})
                return
            if state['connected']:
                radio.disconnect()
            ok = radio.connect(ip)
            self._send(200 if ok else 502, {'ok': ok, 'ip': ip})
            if ok:
                # Set up DAX audio streams after connection
                threading.Thread(target=lambda: (time.sleep(2), setup_dax_streams()), daemon=True).start()

        elif path == '/radio/disconnect':
            radio.disconnect()
            self._send(200, {'ok': True})

        elif path == '/cat/command':
            cmd = body.get('command', '').strip()
            if not cmd:
                self._send(400, {'ok': False, 'error': 'No command'})
                return
            resp = handle_cat(cmd)
            self._send(200, {'ok': True, 'response': resp})

        elif path == '/cwx/send':
            if not state['connected']:
                self._send(503, {'ok': False, 'error': 'Not connected to radio'})
                return
            text = body.get('text', '').strip()
            if not text:
                self._send(400, {'ok': False, 'error': 'No text'})
                return
            # NOTE: SmartSDR v1.4 does not support changing keyer speed via TCP API
            # Speed is controlled by the radio front panel only
            # Do NOT send cwx set wpm= before text — it causes extra CW characters
            radio.cwx_send(text)
            self._send(200, {'ok': True, 'text': text})

        elif path == '/cwx/clear':
            if state['connected']:
                radio.cwx_clear()
            self._send(200, {'ok': True})

        elif path == '/cwx/speed':
            wpm = body.get('wpm', 25)
            state['cwx_speed'] = int(wpm)
            if state['connected']:
                radio.cwx_set_speed(int(wpm))
            self._send(200, {'ok': True, 'wpm': wpm})

        else:
            self._send(404, {'error': 'not found'})


from socketserver import ThreadingMixIn

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each REST request in a separate thread so /status polls never block /cat/command."""
    daemon_threads = True
    allow_reuse_address = True  # SO_REUSEADDR — lets us rebind immediately after crash/restart

def start_rest_api():
    # Bind to 127.0.0.1 explicitly — avoids IPv4/IPv6 dual-stack confusion on macOS
    # where 'localhost' resolves to ::1 but 0.0.0.0 only binds IPv4
    srv = ThreadedHTTPServer(('127.0.0.1', args.status_port), FlexBridgeAPI)
    try:
        srv.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except (AttributeError, OSError):
        pass
    log.info(f'REST API listening on 127.0.0.1:{args.status_port} (threaded)')
    threading.Thread(target=srv.serve_forever, daemon=True).start()

# ── DAX audio bridge (VITA-49 ↔ BlackHole virtual audio) ──────────────────────
# SmartSDR sends/receives DAX audio as VITA-49 (VRT) UDP packets containing
# float32 PCM samples.  We route these through BlackHole so WSJT-X can use
# standard audio device I/O.
#
# WSJT-X config:
#   Soundcard Input  = BlackHole 2ch   (receives RX audio from radio)
#   Soundcard Output = BlackHole 2ch   (sends TX audio to radio)

DAX_UDP_BASE   = 4991          # UDP base port — we use base+channel
DAX_SAMPLE_RATE = 24000        # SmartSDR DAX narrow = 24 kHz
DAX_BLOCK_SIZE  = 128          # samples per audio callback

# VITA-49 header constants
VITA49_PKT_TYPE_IF_DATA     = 0x1  # IF Data with stream ID
VITA49_PKT_TYPE_EXT_DATA    = 0x3  # Extension Data with stream ID
VITA49_HEADER_WORDS         = 7    # header + stream_id + class_id(2) + timestamp(3)
VITA49_HEADER_BYTES         = VITA49_HEADER_WORDS * 4

_dax_rx_streams = {}   # dax_channel -> {'stream_id': int, 'udp_port': int}
_dax_tx_streams = {}   # dax_channel -> {'stream_id': int}
_dax_udp_sock   = None
_dax_running    = False

def _find_blackhole_device():
    """Find BlackHole 2ch device index."""
    try:
        import sounddevice as sd
        for i, d in enumerate(sd.query_devices()):
            if 'BlackHole' in d['name'] and d['max_output_channels'] >= 2:
                return i
        return None
    except Exception as e:
        log.warning(f'[DAX] Cannot query audio devices: {e}')
        return None

_vita49_debug_count = 0

def _parse_vita49_audio(data):
    """Parse a VITA-49 packet and extract float32 PCM samples.
    SmartSDR uses variable-length VITA-49 headers depending on packet flags.
    Returns (stream_id, samples_array) or (None, None) on error.
    """
    global _vita49_debug_count
    import numpy as np
    if len(data) < 8:
        return None, None

    # Word 0: packet header (big-endian)
    hdr = struct.unpack_from('>I', data, 0)[0]
    pkt_type    = (hdr >> 28) & 0xF
    has_class   = (hdr >> 27) & 1  # C bit
    has_trailer = (hdr >> 26) & 1  # T bit
    tsi         = (hdr >> 22) & 0x3  # integer timestamp type
    tsf         = (hdr >> 20) & 0x3  # fractional timestamp type
    pkt_size    = hdr & 0xFFFF       # total packet size in 32-bit words

    # Word 1: stream ID
    stream_id = struct.unpack_from('>I', data, 4)[0]

    # Calculate actual header size from flags
    hdr_words = 2  # header word + stream ID
    if has_class:
        hdr_words += 2  # class ID is 2 words (OUI + class)
    if tsi:
        hdr_words += 1  # integer timestamp
    if tsf:
        hdr_words += 2  # fractional timestamp (64-bit)

    trailer_words = 1 if has_trailer else 0
    payload_words = pkt_size - hdr_words - trailer_words
    payload_offset = hdr_words * 4
    payload_bytes = payload_words * 4

    # Log first few packets for debugging
    if _vita49_debug_count < 3:
        _vita49_debug_count += 1
        log.info(f'[DAX] VITA-49 pkt: type={pkt_type} class={has_class} trailer={has_trailer} '
                 f'tsi={tsi} tsf={tsf} size={pkt_size}w hdr={hdr_words}w payload={payload_words}w '
                 f'stream=0x{stream_id:08X} raw_len={len(data)}')
        if payload_bytes > 0 and payload_offset + payload_bytes <= len(data):
            raw = data[payload_offset:payload_offset+16]
            log.info(f'[DAX] Payload hex (first 16B): {raw.hex()}')
            # Show samples in both endianness
            s_be = np.frombuffer(data, dtype='>f4', offset=payload_offset, count=min(4, payload_words))
            s_le = np.frombuffer(data, dtype='<f4', offset=payload_offset, count=min(4, payload_words))
            log.info(f'[DAX] Samples BE f32: {s_be}')
            log.info(f'[DAX] Samples LE f32: {s_le}')

    if payload_bytes <= 0 or payload_offset + payload_bytes > len(data):
        return stream_id, np.array([], dtype=np.float32)

    # SmartSDR VITA-49 DAX audio: big-endian float32, interleaved stereo (L,R,L,R)
    interleaved = np.frombuffer(data, dtype='>f4', offset=payload_offset, count=payload_words)
    # Extract left channel only (every other sample) — mono is sufficient for FT8/WSJT-X
    if len(interleaved) >= 2:
        samples = interleaved[0::2].copy()  # left channel
    else:
        samples = interleaved.copy()
    return stream_id, samples.astype(np.float32)

def _build_vita49_tx_packet(stream_id, samples, seq_counter):
    """Build a VITA-49 packet from float32 samples for DAX TX."""
    import numpy as np
    payload = samples.astype('>f4').tobytes()
    n_payload_words = len(payload) // 4
    total_words = VITA49_HEADER_WORDS + n_payload_words + 1  # +1 trailer
    # Header word: type=0x1 (IF data w/ stream ID), C=1 (class ID), T=1 (trailer)
    hdr = (0x1 << 28) | (1 << 27) | (1 << 26) | (1 << 20) | ((seq_counter & 0xF) << 16) | (total_words & 0xFFFF)
    # Class ID (2 words) — FlexRadio OUI + DAX audio class
    class_oui = 0x00001C2D  # FlexRadio Systems OUI
    class_id  = 0x03E30000  # DAX audio class
    # Timestamp — fractional (we just use 0)
    ts_int  = 0
    ts_frac_hi = 0
    ts_frac_lo = 0
    header = struct.pack('>IIIIIII',
        hdr, stream_id, class_oui, class_id, ts_int, ts_frac_hi, ts_frac_lo)
    trailer = struct.pack('>I', 0)
    return header + payload + trailer

def start_dax_audio():
    """Start DAX audio bridge: receive VITA-49 RX audio → BlackHole out,
    capture BlackHole in → VITA-49 TX audio back to radio."""
    global _dax_udp_sock, _dax_running

    try:
        import sounddevice as sd
        import numpy as np
    except ImportError as e:
        log.warning(f'[DAX] Cannot start audio bridge — missing module: {e}')
        log.warning('[DAX] Install with: pip3 install sounddevice numpy')
        return

    bh_idx = _find_blackhole_device()
    if bh_idx is None:
        log.warning('[DAX] BlackHole 2ch not found — DAX audio bridge disabled')
        log.warning('[DAX] Install BlackHole: brew install --cask blackhole-2ch')
        return

    bh_name = sd.query_devices(bh_idx)['name']
    log.info(f'[DAX] Using audio device: {bh_name} (index {bh_idx})')

    # Bind UDP socket for VITA-49 audio
    _dax_udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    _dax_udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    udp_port = DAX_UDP_BASE + DAX_CHANNELS[0]
    try:
        _dax_udp_sock.bind(('0.0.0.0', udp_port))
    except OSError:
        # Try a dynamic port if preferred port is busy
        _dax_udp_sock.bind(('0.0.0.0', 0))
        udp_port = _dax_udp_sock.getsockname()[1]
    _dax_udp_sock.settimeout(0.1)
    log.info(f'[DAX] UDP listener on port {udp_port}')

    # Ring buffer for RX audio: VITA-49 packets → BlackHole output
    _rx_buf_lock = threading.Lock()
    _rx_buf = np.zeros(DAX_SAMPLE_RATE * 2, dtype=np.float32)  # 2-second ring
    _rx_write_pos = [0]
    _rx_read_pos  = [0]

    # TX audio ring buffer: BlackHole input → VITA-49 packets
    _tx_buf_lock = threading.Lock()
    _tx_buf = np.zeros(DAX_SAMPLE_RATE * 2, dtype=np.float32)
    _tx_write_pos = [0]
    _tx_read_pos  = [0]

    _dax_running = True
    buf_len = len(_rx_buf)
    _output_callbacks = [0]  # debug counter
    _underruns = [0]

    def _udp_rx_thread():
        """Receive VITA-49 DAX RX packets and write PCM to ring buffer."""
        pkt_count = 0
        while _dax_running:
            try:
                data, addr = _dax_udp_sock.recvfrom(8192)
                stream_id, samples = _parse_vita49_audio(data)
                if samples is not None and len(samples) > 0:
                    n = len(samples)
                    with _rx_buf_lock:
                        wp = _rx_write_pos[0]
                        # Numpy bulk copy into ring buffer
                        start = wp % buf_len
                        if start + n <= buf_len:
                            _rx_buf[start:start + n] = samples
                        else:
                            split = buf_len - start
                            _rx_buf[start:] = samples[:split]
                            _rx_buf[:n - split] = samples[split:]
                        _rx_write_pos[0] = wp + n
                    pkt_count += 1
                    state['dax'][DAX_CHANNELS[0]]['rx_packets'] = pkt_count
            except socket.timeout:
                continue
            except Exception as e:
                if _dax_running:
                    log.debug(f'[DAX] UDP recv: {e}')

    def _audio_output_callback(outdata, frames, time_info, status):
        """sounddevice output callback — feeds RX audio to BlackHole."""
        _output_callbacks[0] += 1
        with _rx_buf_lock:
            rp = _rx_read_pos[0]
            wp = _rx_write_pos[0]
            available = wp - rp
            if available >= frames:
                # Numpy bulk read from ring buffer
                start = rp % buf_len
                if start + frames <= buf_len:
                    mono = _rx_buf[start:start + frames]
                else:
                    split = buf_len - start
                    mono = np.concatenate((_rx_buf[start:], _rx_buf[:frames - split]))
                outdata[:, 0] = mono
                outdata[:, 1] = mono  # mono → stereo
                _rx_read_pos[0] = rp + frames
            else:
                outdata[:] = 0.0
                _underruns[0] += 1
        # Log stats periodically (every ~5 seconds at 24kHz/128 block = ~937 callbacks)
        if _output_callbacks[0] % 1000 == 0:
            log.info(f'[DAX] Audio output: {_output_callbacks[0]} callbacks, {_underruns[0]} underruns, buf_avail={available} samples')

    def _audio_input_callback(indata, frames, time_info, status):
        """sounddevice input callback — captures TX audio from BlackHole."""
        with _tx_buf_lock:
            wp = _tx_write_pos[0]
            n = frames
            start = wp % buf_len
            left = indata[:, 0]
            if start + n <= buf_len:
                _tx_buf[start:start + n] = left
            else:
                split = buf_len - start
                _tx_buf[start:] = left[:split]
                _tx_buf[:n - split] = left[split:]
            _tx_write_pos[0] = wp + n

    # Start sounddevice streams
    try:
        out_stream = sd.OutputStream(
            device=bh_idx,
            samplerate=DAX_SAMPLE_RATE,
            channels=2,
            dtype='float32',
            blocksize=DAX_BLOCK_SIZE,
            callback=_audio_output_callback,
        )
        in_stream = sd.InputStream(
            device=bh_idx,
            samplerate=DAX_SAMPLE_RATE,
            channels=2,
            dtype='float32',
            blocksize=DAX_BLOCK_SIZE,
            callback=_audio_input_callback,
        )
        out_stream.start()
        in_stream.start()
        log.info(f'[DAX] Audio streams started (rate={DAX_SAMPLE_RATE}, device={bh_name})')
    except Exception as e:
        log.error(f'[DAX] Failed to start audio streams: {e}')
        return

    # Start UDP receiver thread
    threading.Thread(target=_udp_rx_thread, daemon=True).start()

    # TX sender thread — reads from TX ring buffer and sends VITA-49 to radio
    def _tx_sender_thread():
        seq = 0
        tx_chunk = 128  # samples per TX packet
        while _dax_running:
            if not state['connected'] or not _dax_tx_streams:
                time.sleep(0.1)
                continue
            with _tx_buf_lock:
                available = _tx_write_pos[0] - _tx_read_pos[0]
            if available >= tx_chunk:
                with _tx_buf_lock:
                    rp = _tx_read_pos[0]
                    chunk = np.array([_tx_buf[(rp + i) % buf_len] for i in range(tx_chunk)], dtype=np.float32)
                    _tx_read_pos[0] = rp + tx_chunk
                for ch, info in _dax_tx_streams.items():
                    pkt = _build_vita49_tx_packet(info['stream_id'], chunk, seq)
                    try:
                        _dax_udp_sock.sendto(pkt, (state['radio_ip'], 4991))
                    except Exception as e:
                        log.debug(f'[DAX] TX send error: {e}')
                seq = (seq + 1) & 0xF
            else:
                time.sleep(0.004)  # ~4ms = ~96 samples at 24kHz

    threading.Thread(target=_tx_sender_thread, daemon=True).start()
    log.info('[DAX] Audio bridge running')

def setup_dax_streams():
    """Register UDP port with SmartSDR and create DAX audio streams.
    Called after SmartSDR connection is established."""
    if not _dax_udp_sock or not state['connected']:
        return
    udp_port = _dax_udp_sock.getsockname()[1]
    log.info(f'[DAX] Registering UDP port {udp_port} with SmartSDR')
    radio.cmd(f'client udpport {udp_port}')
    time.sleep(0.5)
    for ch in DAX_CHANNELS:
        sl = state['slice']
        # Create DAX RX stream — capture stream ID from response
        def _on_rx_stream(msg, _ch=ch):
            try:
                sid = int(msg.strip(), 16)
                _dax_rx_streams[_ch] = {'stream_id': sid}
                log.info(f'[DAX] RX stream created: channel={_ch}, stream_id=0x{sid:08X}')
            except ValueError:
                log.warning(f'[DAX] Could not parse RX stream ID: {msg}')
        log.info(f'[DAX] Creating DAX RX stream: channel={ch}, slice={sl}')
        seq = radio.cmd(f'stream create type=dax_rx dax_channel={ch}')
        if seq is not None:
            radio.handlers[str(seq)] = _on_rx_stream
        time.sleep(0.5)

        # Create DAX TX stream
        def _on_tx_stream(msg, _ch=ch):
            try:
                sid = int(msg.strip(), 16)
                _dax_tx_streams[_ch] = {'stream_id': sid}
                log.info(f'[DAX] TX stream created: channel={_ch}, stream_id=0x{sid:08X}')
            except ValueError:
                log.warning(f'[DAX] Could not parse TX stream ID: {msg}')
        log.info(f'[DAX] Creating DAX TX stream: channel={ch}')
        seq = radio.cmd(f'stream create type=dax_tx dax_channel={ch}')
        if seq is not None:
            radio.handlers[str(seq)] = _on_tx_stream
        time.sleep(0.5)

        # Assign DAX channel to our slice
        radio.cmd(f'dax audio set {ch} slice={sl} tx=1')
    log.info('[DAX] Stream setup complete')

# ── Auto-connect if IP provided ────────────────────────────────────────────────
def auto_connect():
    if args.radio:
        log.info(f'Auto-connecting to {args.radio}...')
        time.sleep(1)  # brief pause for REST API to start
        radio.connect(args.radio)
        # After connection, set up DAX streams
        time.sleep(2)  # wait for SmartSDR registration to complete
        if state['connected']:
            setup_dax_streams()
    else:
        log.info('No --radio specified, waiting for /radio/connect call or auto-discovery')

# ── Main ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    log.info(f'FlexBridge starting — CAT port {args.cat_port}, REST port {args.status_port}')
    log.info(f'DAX channels: {DAX_CHANNELS}')

    start_rest_api()       # REST up first — browser can poll immediately
    start_pty_server()
    start_tcp_cat_server()
    start_dax_audio()      # DAX audio bridge (VITA-49 ↔ BlackHole)

    # Start discovery after REST API is bound
    threading.Thread(target=auto_connect, daemon=True).start()

    log.info(f'PTY symlink:  {PTY_SYMLINK}')
    log.info(f'TCP CAT:      127.0.0.1:{args.cat_port}')
    log.info(f'REST API:     http://127.0.0.1:{args.status_port}')
    log.info(f'DAX audio:    BlackHole 2ch (channels={DAX_CHANNELS})')
    log.info('Ready. Press Ctrl+C to stop.')

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info('Stopping FlexBridge')
        radio.disconnect()
        sys.exit(0)
