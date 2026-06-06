# Awrit ![NixOS](https://img.shields.io/badge/-NixOS-5277C3.svg?style=flat-square&logo=nixos&logoColor=white)

> Personal fork of [`chase/awrit`](https://github.com/chase/awrit). See upstream for full documentation.
>
> *Note: Force Push Ahead.*

## Features & Roadmap
- [x] Built-in Google Sign-In support (GIS and direct sign-in)
- [x] 2-finger horizontal swipe for back/forward history navigation
- [x] Vim-style keyboard bindings for page navigation
- [x] Site-wise context zoom control (`Alt+-` / `Alt+=` / `Ctrl+0`)
- [x] Zen-inspired Omnibox with intelligent search suggestions
- [x] Interactive site permissions overlay via omnibox (camera, mic, geolocation)
- [x] Multi-window handling support
- [x] Bidirectional system clipboard interoperability (OSC 52 + bracketed paste)
- [x] Proper standard XDG storage paths for data and logs (`~/.local/share/awrit`)
- [x] Find in page functionality (`Alt+/`)
- [x] Zero-latency page swaps ("Flash Killer")
- [x] Website click-to-copy and double/triple-click text selection
- [x] Custom error pages for network failures and crashes
- [x] Link hover status indicators
- [x] In-app DevTools toggling (`F12` / `Ctrl+Shift+I`)
- [x] Chrome DevTools Protocol (CDP) support (`--remote-debugging-port=9222`)
- [x] Aggressive resource limits (30fps caps, disabled spellchecker)
- [x] Tear-free synchronized terminal output (2026 mode)
- [x] High-performance rendering (BGRA->RGBA dirty rects, SIMD pass)
- [ ] Browser tabs support
- [ ] Settings page UI
- [ ] History navigation and cleanup
- [ ] Cookies and site data management

![awrit screenshot](assets/screenshot.jpg)

## Install

**Nix (Recommended):**
```bash
# Run instantly without installing
nix run github:creator54/awrit -- https://github.com/creator54/awrit

# Or install to your user profile
nix profile install github:creator54/awrit

# For local development
git clone https://github.com/creator54/awrit.git && cd awrit
nix run .
```

**Standard Linux:**
```bash
git clone https://github.com/creator54/awrit.git
cd awrit
./setup.sh
./awrit
```
