"""gamectl.py -- drive the Mercs2 window by hand: focus, keypress, screenshot.

Replaces launch.py's blind tap sequence for menu navigation. Keys go through
SendInput with hardware scan codes, because the game reads DirectInput-style
keyboard state and ignores the WM_KEYDOWN messages that SendKeys/PostMessage
produce.

  python gamectl.py shot out.png       capture the game window
  python gamectl.py key space          press a key
  python gamectl.py key right
  python gamectl.py focus
  python gamectl.py state              is it running / window title
"""
import ctypes
import ctypes.wintypes as w
import sys
import time

u32 = ctypes.windll.user32
gdi = ctypes.windll.gdi32

# Scan codes (set 1). SendInput with SCANCODE is what DirectInput actually sees.
SC = {
    "space": 0x39, "right": 0x4D, "left": 0x4B, "up": 0x48, "down": 0x50,
    "enter": 0x1C, "esc": 0x01, "a": 0x1E, "b": 0x30, "y": 0x15, "n": 0x31,
    "f1": 0x3B, "f2": 0x3C, "f3": 0x3D, "f4": 0x3E, "f5": 0x3F, "f6": 0x40,
}
EXTENDED = {"right", "left", "up", "down"}   # arrows need the E0 prefix flag

KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", ctypes.POINTER(w.ULONG))]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", w.DWORD), ("u", _U)]


def find_window():
    """Find the game's top-level window. Class/title vary, so match the process."""
    result = []

    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def cb(hwnd, _):
        if not u32.IsWindowVisible(hwnd):
            return True
        pid = w.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(hwnd, buf, 512)
        title = buf.value
        try:
            import subprocess
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid.value}", "/NH"],
                capture_output=True, text=True, timeout=10).stdout
        except Exception:
            return True
        if "Mercenaries2" in out:
            result.append((hwnd, title))
            return False
        return True

    u32.EnumWindows(cb, 0)
    return result[0] if result else (None, None)


def focus(hwnd):
    u32.ShowWindow(hwnd, 9)          # SW_RESTORE
    u32.SetForegroundWindow(hwnd)
    time.sleep(0.35)


def press(name, hold=0.06):
    sc = SC.get(name.lower())
    if sc is None:
        raise SystemExit(f"unknown key: {name}")
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if name.lower() in EXTENDED else 0)
    down = INPUT(type=1, ki=KEYBDINPUT(0, sc, flags, 0, None))
    up = INPUT(type=1, ki=KEYBDINPUT(0, sc, flags | KEYEVENTF_KEYUP, 0, None))
    u32.SendInput(1, ctypes.byref(down), ctypes.sizeof(INPUT))
    time.sleep(hold)
    u32.SendInput(1, ctypes.byref(up), ctypes.sizeof(INPUT))


def shot(hwnd, path):
    """PrintWindow with flag 2 (PW_RENDERFULLCONTENT) -- plain BitBlt of a
    D3D surface usually comes back black."""
    rect = w.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(rect))
    width, height = rect.right - rect.left, rect.bottom - rect.top
    hdc = u32.GetWindowDC(hwnd)
    mem = gdi.CreateCompatibleDC(hdc)
    bmp = gdi.CreateCompatibleBitmap(hdc, width, height)
    gdi.SelectObject(mem, bmp)
    ok = u32.PrintWindow(hwnd, mem, 2)
    if not ok:
        gdi.BitBlt(mem, 0, 0, width, height, hdc, 0, 0, 0x00CC0020)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG),
                    ("biPlanes", w.WORD), ("biBitCount", w.WORD),
                    ("biCompression", w.DWORD), ("biSizeImage", w.DWORD),
                    ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
                    ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD)]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth, bi.biHeight = width, -height     # negative = top-down
    bi.biPlanes, bi.biBitCount, bi.biCompression = 1, 24, 0
    stride = ((width * 3 + 3) // 4) * 4
    buf = ctypes.create_string_buffer(stride * height)
    gdi.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(bi), 0)

    # Write a BMP by hand -- no PIL dependency.
    import struct
    size = 54 + len(buf.raw)
    with open(path, "wb") as f:
        f.write(b"BM" + struct.pack("<IHHI", size, 0, 0, 54))
        f.write(struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 24, 0,
                            len(buf.raw), 2835, 2835, 0, 0))
        f.write(buf.raw)

    gdi.DeleteObject(bmp)
    gdi.DeleteDC(mem)
    u32.ReleaseDC(hwnd, hdc)
    return width, height, ok


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    hwnd, title = find_window()
    if not hwnd:
        print("[FAIL] no Mercenaries2 window found (is it running?)")
        return 1
    if cmd == "state":
        print(f"[ok] hwnd={hwnd} title={title!r}")
        return 0
    if cmd == "focus":
        focus(hwnd)
        print(f"[ok] focused {title!r}")
        return 0
    if cmd == "key":
        focus(hwnd)
        for k in sys.argv[2:]:
            press(k)
            print(f"[ok] pressed {k}")
            time.sleep(0.25)
        return 0
    if cmd == "shot":
        out = sys.argv[2] if len(sys.argv) > 2 else "shot.bmp"
        wd, ht, ok = shot(hwnd, out)
        print(f"[ok] wrote {out} ({wd}x{ht}) printwindow={bool(ok)}")
        return 0
    raise SystemExit(f"unknown command: {cmd}")


if __name__ == "__main__":
    sys.exit(main())
