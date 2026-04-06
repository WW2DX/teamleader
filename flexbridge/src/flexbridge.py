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
    if cmd == 'IF':
        freq  = f'{state["freq_hz"]:011d}'
        mode  = _mode_to_ts2000(state['mode'])
        # IF format: IF[11 freq][5 rit][?][?][?][?][1 rit on][1 xit][1 mem][3 mem#][1 tx/rx][1 mode][1 vfo][1 scan][1 split][1 tone][1 tone#][?]
        return f'IF{freq}     +000000000{mode}0000000;'

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
    """TCP server on args.cat_port accepting CAT commands."""
    def _handle_client(conn, addr):
        log.info(f'CAT TCP client connected: {addr}')
        buf = ''
        try:
            while True:
                data = conn.recv(256)
                if not data:
                    break
                buf += data.decode('ascii', errors='replace')
                while ';' in buf:
                    cmd, buf = buf.split(';', 1)
                    resp = handle_cat(cmd + ';')
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
            self._send(200, state['dax'])

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

# ── Auto-connect if IP provided ────────────────────────────────────────────────
def auto_connect():
    if args.radio:
        log.info(f'Auto-connecting to {args.radio}...')
        time.sleep(1)  # brief pause for REST API to start
        radio.connect(args.radio)
    else:
        log.info('No --radio specified, waiting for /radio/connect call or auto-discovery')

# ── Main ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    log.info(f'FlexBridge starting — CAT port {args.cat_port}, REST port {args.status_port}')
    log.info(f'DAX channels: {DAX_CHANNELS}')

    start_rest_api()       # REST up first — browser can poll immediately
    start_pty_server()
    start_tcp_cat_server()

    # Start discovery after REST API is bound
    threading.Thread(target=auto_connect, daemon=True).start()

    log.info(f'PTY symlink:  {PTY_SYMLINK}')
    log.info(f'TCP CAT:      127.0.0.1:{args.cat_port}')
    log.info(f'REST API:     http://127.0.0.1:{args.status_port}')
    log.info('Ready. Press Ctrl+C to stop.')

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info('Stopping FlexBridge')
        radio.disconnect()
        sys.exit(0)
