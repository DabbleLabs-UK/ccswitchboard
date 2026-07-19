//go:build windows

package main

import (
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	hwndGlobal  uintptr // hidden message window
	hIconGlobal uintptr // application icon shared by window class + tray

	// nid is the single NOTIFYICONDATAW reused for add/modify/delete. All
	// access is serialized because it is touched from the tunnel goroutine
	// (updateTip/showBalloon) as well as the UI thread (addIcon/deleteIcon).
	niMu sync.Mutex
	nid  NOTIFYICONDATAW
)

// wndProc is the window procedure. It is wrapped with syscall.NewCallback and
// invoked by DispatchMessageW on the (OS-thread-locked) main goroutine.
func wndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmTrayCallback:
		// The mouse message is in the low word of lParam for both the legacy
		// and the version-4 shell callback conventions, so LOWORD works either
		// way (we use GetCursorPos rather than unpacking coordinates).
		low := lparam & 0xFFFF
		if low == WM_RBUTTONUP || low == WM_LBUTTONUP || low == WM_CONTEXTMENU {
			showMenu(hwnd)
		}
		return 0
	case WM_DESTROY:
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return ret
}

// createWindow registers the window class and creates a hidden window that
// receives the tray callback messages.
func createWindow() error {
	hInstance, _, _ := procGetModuleHandleW.Call(0)

	className, err := syscall.UTF16PtrFromString("CCSWRelayTrayWindowClass")
	if err != nil {
		return err
	}
	windowName, err := syscall.UTF16PtrFromString("CCSwitchboard Relay")
	if err != nil {
		return err
	}

	hIconGlobal, _, _ = procLoadIconW.Call(0, uintptr(IDI_APPLICATION))
	hCursor, _, _ := procLoadCursorW.Call(0, uintptr(IDC_ARROW))

	var wc WNDCLASSEXW
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	wc.LpfnWndProc = syscall.NewCallback(wndProc)
	wc.HInstance = hInstance
	wc.HIcon = hIconGlobal
	wc.HIconSm = hIconGlobal
	wc.HCursor = hCursor
	wc.LpszClassName = className

	atom, _, e := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if atom == 0 {
		return e
	}

	// WS_OVERLAPPED (0) window that is never shown -> stays hidden.
	hwnd, _, e := procCreateWindowExW.Call(
		0, // dwExStyle
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		0,          // dwStyle
		0, 0, 0, 0, // x, y, w, h
		0,         // hWndParent
		0,         // hMenu
		hInstance, // hInstance
		0,         // lpParam
	)
	if hwnd == 0 {
		return e
	}
	hwndGlobal = hwnd
	return nil
}

// addIcon adds the tray icon with the given tooltip.
func addIcon(tip string) {
	niMu.Lock()
	defer niMu.Unlock()
	nid = NOTIFYICONDATAW{}
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = hwndGlobal
	nid.UID = 1
	nid.UFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
	nid.UCallbackMessage = wmTrayCallback
	nid.HIcon = hIconGlobal
	setUTF16(nid.SzTip[:], tip)
	procShellNotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
}

// updateTip changes the tray tooltip text.
func updateTip(tip string) {
	niMu.Lock()
	defer niMu.Unlock()
	nid.UFlags = NIF_TIP
	setUTF16(nid.SzTip[:], tip)
	procShellNotifyIconW.Call(NIM_MODIFY, uintptr(unsafe.Pointer(&nid)))
}

// showBalloon shows a balloon notification.
func showBalloon(title, body string) {
	niMu.Lock()
	defer niMu.Unlock()
	nid.UFlags = NIF_INFO
	nid.DwInfoFlags = NIIF_INFO
	setUTF16(nid.SzInfoTitle[:], title)
	setUTF16(nid.SzInfo[:], body)
	procShellNotifyIconW.Call(NIM_MODIFY, uintptr(unsafe.Pointer(&nid)))
}

// deleteIcon removes the tray icon.
func deleteIcon() {
	niMu.Lock()
	defer niMu.Unlock()
	procShellNotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
}

// setUTF16 encodes s into the fixed-size UTF-16 buffer dst, NUL-terminated and
// truncated to fit. The remainder of dst is zeroed.
func setUTF16(dst []uint16, s string) {
	for i := range dst {
		dst[i] = 0
	}
	enc := utf16.Encode([]rune(s))
	n := len(enc)
	if n > len(dst)-1 {
		n = len(dst) - 1
	}
	copy(dst[:n], enc[:n])
}

// showMenu builds and shows the tray popup menu and acts on the chosen command.
func showMenu(hwnd uintptr) {
	var pt POINT
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForegroundWin.Call(hwnd)

	hmenu, _, _ := procCreatePopupMenu.Call()

	pub := getPublicURL()

	// Info line: app version (so the running build is unmistakable).
	appendMenuStr(hmenu, MF_STRING|MF_GRAYED|MF_DISABLED, 0, "CCSwitchboard Relay v"+appVersion)

	// Info line: local relay URL (including the board's sub-path).
	appendMenuStr(hmenu, MF_STRING|MF_GRAYED|MF_DISABLED, 0, "Relay: "+localURL+basePath+"/")

	// Info line: tunnel / public URL.
	var tunnelLine string
	switch {
	case pub != "":
		tunnelLine = "Tunnel: " + pub + basePath + "/"
	case cloudflaredPath == "":
		tunnelLine = "Tunnel: not available"
	default:
		tunnelLine = "Tunnel: starting…"
	}
	appendMenuStr(hmenu, MF_STRING|MF_GRAYED|MF_DISABLED, 0, tunnelLine)

	appendMenuSep(hmenu)

	// 1: Copy public URL (grayed if no public URL yet).
	copyFlags := uintptr(MF_STRING)
	if pub == "" {
		copyFlags = MF_STRING | MF_GRAYED | MF_DISABLED
	}
	appendMenuStr(hmenu, copyFlags, 1, "Copy public URL")

	// 6: Copy relay token (grayed until the relay has generated it).
	tokFlags := uintptr(MF_STRING)
	if getRelayToken() == "" {
		tokFlags = MF_STRING | MF_GRAYED | MF_DISABLED
	}
	appendMenuStr(hmenu, tokFlags, 6, "Copy relay token")

	// 2: Open dashboard (auto-logs-in with the token when known).
	appendMenuStr(hmenu, MF_STRING, 2, "Open dashboard")

	// 3: Open log.
	appendMenuStr(hmenu, MF_STRING, 3, "Open log")

	// 4: Restart tunnel (grayed if cloudflared missing).
	restartFlags := uintptr(MF_STRING)
	if cloudflaredPath == "" {
		restartFlags = MF_STRING | MF_GRAYED | MF_DISABLED
	}
	appendMenuStr(hmenu, restartFlags, 4, "Restart tunnel")

	appendMenuSep(hmenu)

	// 5: Quit.
	appendMenuStr(hmenu, MF_STRING, 5, "Quit")

	cmd, _, _ := procTrackPopupMenu.Call(
		hmenu,
		TPM_RIGHTBUTTON|TPM_RETURNCMD|TPM_NONOTIFY,
		uintptr(pt.X),
		uintptr(pt.Y),
		0,
		hwnd,
		0,
	)

	// Recommended by MSDN so the menu dismisses cleanly.
	procPostMessageW.Call(hwnd, WM_NULL, 0, 0)
	procDestroyMenu.Call(hmenu)

	switch cmd {
	case 1: // Copy public URL (the board's public base URL)
		if pub != "" {
			boardURL := pub + basePath + "/"
			setClipboard(hwnd, boardURL)
			logf("copied public URL to clipboard: %s", boardURL)
		}
	case 2: // Open dashboard (auto-login with token when available)
		base := pub
		if base == "" {
			base = localURL
		}
		base += basePath // the board is served under this sub-path
		target := base + "/index.php"
		if tok := getRelayToken(); tok != "" {
			target += "?token=" + tok
		}
		shellOpen(target)
		logf("open dashboard: %s/index.php", base) // token deliberately not logged
	case 6: // Copy relay token
		if tok := getRelayToken(); tok != "" {
			setClipboard(hwnd, tok)
			logf("copied relay token to clipboard (%d chars)", len(tok))
		}
	case 3: // Open log
		shellOpen(logPath)
		logf("open log: %s", logPath)
	case 4: // Restart tunnel
		if cloudflaredPath != "" {
			logf("restart tunnel requested from menu")
			restartTunnel()
		}
	case 5: // Quit
		logf("quit requested from menu")
		quitApp(hwnd)
	}
}

func appendMenuStr(hmenu, flags, id uintptr, text string) {
	p, _ := syscall.UTF16PtrFromString(text)
	procAppendMenuW.Call(hmenu, flags, id, uintptr(unsafe.Pointer(p)))
}

func appendMenuSep(hmenu uintptr) {
	procAppendMenuW.Call(hmenu, MF_SEPARATOR, 0, 0)
}

// shellOpen launches the default handler ("open" verb) for target.
func shellOpen(target string) {
	op, _ := syscall.UTF16PtrFromString("open")
	t, _ := syscall.UTF16PtrFromString(target)
	procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(op)),
		uintptr(unsafe.Pointer(t)),
		0,
		0,
		SW_SHOWNORMAL,
	)
}

// setClipboard copies s to the clipboard as CF_UNICODETEXT. The moveable global
// memory is handed to the system via SetClipboardData and must NOT be freed.
func setClipboard(hwnd uintptr, s string) {
	enc := utf16.Encode([]rune(s))
	enc = append(enc, 0) // NUL terminator
	byteLen := len(enc) * 2

	r, _, _ := procOpenClipboard.Call(hwnd)
	if r == 0 {
		logf("clipboard: OpenClipboard failed")
		return
	}
	defer procCloseClipboard.Call()

	procEmptyClipboard.Call()

	hMem, _, _ := procGlobalAlloc.Call(GMEM_MOVEABLE, uintptr(byteLen))
	if hMem == 0 {
		logf("clipboard: GlobalAlloc failed")
		return
	}
	p, _, _ := procGlobalLock.Call(hMem)
	if p == 0 {
		logf("clipboard: GlobalLock failed")
		return
	}
	// Copy the UTF-16 buffer into the (non-Go-managed) global memory. Using
	// RtlMoveMemory keeps the destination a plain uintptr and the source in the
	// vet-approved unsafe.Pointer->uintptr call-argument form, so no uintptr is
	// ever converted back to unsafe.Pointer.
	procRtlMoveMemory.Call(p, uintptr(unsafe.Pointer(&enc[0])), uintptr(byteLen))
	procGlobalUnlock.Call(hMem)

	procSetClipboardData.Call(CF_UNICODETEXT, hMem)
}

// messageLoop runs the standard Win32 message pump. It must run on the same
// (locked) OS thread that created the window.
func messageLoop() {
	var msg MSG
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		switch int32(r) {
		case 0: // WM_QUIT
			return
		case -1: // error
			logf("GetMessageW returned -1")
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// quitApp performs the full shutdown sequence.
func quitApp(hwnd uintptr) {
	killChildren()
	deleteIcon()
	procPostQuitMessage.Call(0)
}
