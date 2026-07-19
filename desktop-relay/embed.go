//go:build windows

package main

import "embed"

// embeddedRelay carries the entire CCSwitchboard relay (the board/ PHP app,
// laid out under webroot/ccswitchboard/board so it serves at the sub-path the
// relay's cookie expects). It is written to disk on launch (see
// extractEmbeddedRelay) because php -S executes real files, not an embed.FS.
// This is what makes the app self-contained: no local WAMP, no junction, no
// separate download — the relay ships inside the exe.
//
//go:embed all:webroot
var embeddedRelay embed.FS
