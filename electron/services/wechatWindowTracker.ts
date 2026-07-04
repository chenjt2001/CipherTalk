import { screen } from 'electron'
import { wxKeyService } from './wxKeyService'

/**
 * Windows-only WeChat main-window tracker for the reply suggestion tile.
 *
 * WeChat image preview / media viewer windows are also top-level windows owned by
 * Weixin.exe, so do not pick the largest WeChat-owned window. Track only the real
 * Chinese-titled main window instead.
 */

export type WeChatWindowState = {
  found: boolean
  minimized: boolean
  /** True only when the foreground window is the real Chinese-titled WeChat main window. */
  foregroundActive: boolean
  /** DIP bounds; null when found is false. */
  bounds: { x: number; y: number; width: number; height: number } | null
}

const NOT_FOUND: WeChatWindowState = { found: false, minimized: false, foregroundActive: false, bounds: null }

const GW_HWNDNEXT = 2
const DWMWA_EXTENDED_FRAME_BOUNDS = 9

let loaded = false
let unavailable = false
let koffi: any = null
let GetTopWindow: any, GetWindow: any, GetWindowThreadProcessId: any
let IsWindowVisible: any, IsIconic: any, GetWindowTextLengthW: any, GetWindowTextW: any
let GetWindowRect: any, GetForegroundWindow: any, DwmGetWindowAttribute: any
let pidBuf: any = null
let rectBuf: any = null
let titleBuf: Buffer | null = null

let cachedPid: number | null = null
let lastPidProbe = 0

function ensureLoaded(): boolean {
  if (loaded) return !unavailable
  loaded = true
  try {
    koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    GetTopWindow = user32.func('void* GetTopWindow(void* hwnd)')
    GetWindow = user32.func('void* GetWindow(void* hwnd, uint32 uCmd)')
    GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hwnd, void* pid)')
    IsWindowVisible = user32.func('bool IsWindowVisible(void* hwnd)')
    IsIconic = user32.func('bool IsIconic(void* hwnd)')
    GetWindowTextLengthW = user32.func('int32 GetWindowTextLengthW(void* hwnd)')
    GetWindowTextW = user32.func('int32 GetWindowTextW(void* hwnd, void* text, int32 maxCount)')
    GetWindowRect = user32.func('bool GetWindowRect(void* hwnd, void* rect)')
    GetForegroundWindow = user32.func('void* GetForegroundWindow()')
    DwmGetWindowAttribute = dwmapi.func('int32 DwmGetWindowAttribute(void* hwnd, uint32 attr, void* rect, uint32 cb)')
    pidBuf = koffi.alloc('uint32', 1)
    rectBuf = koffi.alloc('int32', 4)
    titleBuf = Buffer.alloc(512 * 2)
    return true
  } catch {
    unavailable = true
    return false
  }
}

function readPid(hwnd: any): number {
  GetWindowThreadProcessId(hwnd, pidBuf)
  return koffi.decode(pidBuf, 'uint32', 1)[0]
}

function readRect(hwnd: any): { left: number; top: number; right: number; bottom: number } | null {
  const ok = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rectBuf, 16) === 0
    || GetWindowRect(hwnd, rectBuf)
  if (!ok) return null
  const [left, top, right, bottom] = koffi.decode(rectBuf, 'int32', 4)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom }
}

function readTitle(hwnd: any): string {
  if (!titleBuf) return ''
  const len = GetWindowTextLengthW(hwnd)
  if (len <= 0) return ''
  titleBuf.fill(0)
  GetWindowTextW(hwnd, titleBuf, 512)
  return titleBuf.toString('ucs2').replace(/\u0000+$/, '').trim()
}

function isWeChatMainTitle(title: string): boolean {
  return title === '\u5fae\u4fe1'
}

function hwndAddress(hwnd: any): bigint {
  try { return koffi.address(hwnd) as bigint } catch { return 0n }
}

function findMainWindow(pid: number): { hwnd: any; hwndAddr: bigint; rect: { left: number; top: number; right: number; bottom: number } } | null {
  let hwnd = GetTopWindow(null)
  let best: { hwnd: any; hwndAddr: bigint; rect: any; area: number } | null = null
  let guard = 0
  while (hwnd && guard++ < 5000) {
    if (readPid(hwnd) === pid && IsWindowVisible(hwnd) && isWeChatMainTitle(readTitle(hwnd))) {
      const rect = readRect(hwnd)
      if (rect) {
        const area = (rect.right - rect.left) * (rect.bottom - rect.top)
        if (!best || area > best.area) best = { hwnd, hwndAddr: hwndAddress(hwnd), rect, area }
      }
    }
    hwnd = GetWindow(hwnd, GW_HWNDNEXT)
  }
  return best ? { hwnd: best.hwnd, hwndAddr: best.hwndAddr, rect: best.rect } : null
}

function foregroundHwndAddress(): bigint {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return 0n
  return hwndAddress(hwnd)
}

export function probeWeChatWindow(): WeChatWindowState {
  if (process.platform !== 'win32' || !ensureLoaded()) return NOT_FOUND

  let pid = cachedPid
  let main = pid ? findMainWindow(pid) : null
  if (!main) {
    const now = Date.now()
    if (now - lastPidProbe > 3000) {
      lastPidProbe = now
      cachedPid = wxKeyService.getWeChatPid()
      pid = cachedPid
      main = pid ? findMainWindow(pid) : null
    }
  }
  if (!pid || !main) return NOT_FOUND

  const minimized = IsIconic(main.hwnd)
  const foregroundActive = foregroundHwndAddress() === main.hwndAddr
  const { left, top, right, bottom } = main.rect
  const dip = screen.screenToDipRect(null, { x: left, y: top, width: right - left, height: bottom - top })
  return { found: true, minimized, foregroundActive, bounds: { x: dip.x, y: dip.y, width: dip.width, height: dip.height } }
}
