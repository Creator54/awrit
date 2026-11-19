# Changelog

## [2.2.2](https://github.com/Creator54/awrit/compare/v2.2.1...v2.2.2) (2026-11-19)


### Fixes

* clear page highlights when Find closes ([49ada8d](https://github.com/Creator54/awrit/commit/49ada8ddb744db90656ca2782cb70af7d7f4cc3e))
* close address bar before shortcut help ([4c69042](https://github.com/Creator54/awrit/commit/4c690421615ee1866d10cc8451cc2d20e8f7b695))
* close shortcut help before opening address bar ([4b495b8](https://github.com/Creator54/awrit/commit/4b495b89fcc624debb1bded30dea45409d6a08a9))
* close shortcut help before opening Find ([0c14492](https://github.com/Creator54/awrit/commit/0c14492a8afe8d0b49a9111500ee39f9b11e38ea))
* fit Android controls in narrow panes ([eafd72c](https://github.com/Creator54/awrit/commit/eafd72c3226bf31aa3a9d9fcb80cb12d33c194b5))
* fit Find controls in very short panes ([03c6513](https://github.com/Creator54/awrit/commit/03c65136db5c620e9d138621f5d39fcfa33b4563))
* fit permission buttons in very short panes ([cad529f](https://github.com/Creator54/awrit/commit/cad529f9ebb1a1348b3b4219b5c742fecc77c84a))
* give the omnibox more room in wide panes ([0c46025](https://github.com/Creator54/awrit/commit/0c46025223427801b3756166b941ea72df349975))
* guard shortcut focus during permission prompts ([0c8d827](https://github.com/Creator54/awrit/commit/0c8d82752d49abc940c31ba2c91080e67d977c3a))
* ignore stale permission responses before routing input ([220c5d5](https://github.com/Creator54/awrit/commit/220c5d5b95207a51a32d23aa7f3b4284e08ac762))
* keep controls usable in small panes ([41767d0](https://github.com/Creator54/awrit/commit/41767d03d86383abe4ca8f9d06fd47c9fb8e3de0))
* keep delayed focus out of permission prompts ([036a9df](https://github.com/Creator54/awrit/commit/036a9df14b3792512b9f99f91371325974f3dcd2))
* keep macOS owner socket paths within limit ([7badc14](https://github.com/Creator54/awrit/commit/7badc1428417627fe13ab84c94712b3046af5990))
* keep permission Escape from closing other panels ([1936543](https://github.com/Creator54/awrit/commit/193654384e70a5afeb4d37afb3ad9a363d6c98aa))
* keep permission focus on address bar close ([37d09f9](https://github.com/Creator54/awrit/commit/37d09f915feb70d9b9173e24dd6c5c9bab8af735))
* keep shortcut search visible in short panes ([6f96a64](https://github.com/Creator54/awrit/commit/6f96a64a03a1bd59961d684cc2654e8f5bdbaf0d))
* keep site controls usable in small panes ([9b08f8f](https://github.com/Creator54/awrit/commit/9b08f8f7b92827d9df906649dec043c855f7dc54))
* open Find after the toolbar finishes loading ([7abb280](https://github.com/Creator54/awrit/commit/7abb280794ce740bb3378b751393d087ffc075e2))
* preserve focus when clearing Find query ([e5c1719](https://github.com/Creator54/awrit/commit/e5c1719cf748d68c1674ee28f6372d26d2a2982d))
* preserve toolbar input when exiting Design Mode ([6f74477](https://github.com/Creator54/awrit/commit/6f74477697ca7cfa50735c3f69e911c7bc2942a9))
* preserve WebGL in standalone snapshots ([7aa58ee](https://github.com/Creator54/awrit/commit/7aa58ee04a9304da41b86a789e0a8b9e6106e853))
* prioritize review editors in short panes ([2ccf6b1](https://github.com/Creator54/awrit/commit/2ccf6b167d7d230dec7dfc7c230c4b0b4c3f3392))
* restore Design Mode focus after permission prompts ([c6ebfd5](https://github.com/Creator54/awrit/commit/c6ebfd51147703eec5944b8eec0e0246d5953c5f))
* restore toolbar control after permission prompt ([cdb1ff3](https://github.com/Creator54/awrit/commit/cdb1ff3237356cc4073299a4127834fc44556ce9))
* route pointer input to permission prompts ([b5bd09f](https://github.com/Creator54/awrit/commit/b5bd09f0b75ed669bb26696352868f9687abc0fd))
* route remote paste to active toolbar overlays ([4592cba](https://github.com/Creator54/awrit/commit/4592cbada1cd81e73515dfe51d4825bf36abf208))
* scroll note cards at editor boundaries ([4ccc263](https://github.com/Creator54/awrit/commit/4ccc2637aa020e211cd304404ddbee35bb667226))
* trim copy in compact review controls ([03e4851](https://github.com/Creator54/awrit/commit/03e48514f4e60b0d40e5994d5134f6a9f1d46c9e))

## [2.2.1](https://github.com/Creator54/awrit/compare/v2.2.0...v2.2.1) (2026-11-16)


### Fixes

* keep runtime packages external in release bundle ([4352a4c](https://github.com/Creator54/awrit/commit/4352a4c5a4d519c582b476bf600b7a44292f728a))

## [2.2.0](https://github.com/Creator54/awrit/compare/v2.1.0...v2.2.0) (2026-11-16)


### Features

* add error pages for network failures and renderer crashes ([d21eaab](https://github.com/Creator54/awrit/commit/d21eaab38eef0cc8ad1afbd774bd38419d8aeb61))
* add link hover and navigation status indicator ([ab15697](https://github.com/Creator54/awrit/commit/ab15697bad1d61aea515778c18490150717e1ce1))
* add toggleDevTools command (F12/Ctrl+Shift+I) ([312f6ad](https://github.com/Creator54/awrit/commit/312f6ad560160bb24fe613b47c9cac64bff080aa))
* add vim-style keyboard navigation ([c4145bd](https://github.com/Creator54/awrit/commit/c4145bd63f31d1733c8e27d50b682ff165b1755e))
* Alt+ zoom with per-origin persistence ([81986f5](https://github.com/Creator54/awrit/commit/81986f5adff65977b09da3c2fc4446a4130f21ca))
* automatically break LLM agent input lockouts on terminal focus ([a382129](https://github.com/Creator54/awrit/commit/a38212967c302c74d14da470193c79e01233841c))
* double and triple-click text selection support ([dbd384e](https://github.com/Creator54/awrit/commit/dbd384e933d17a609fe8c3f76076d453cc792db3))
* enable JS-animated auto-hiding overlay scrollbars and update nix dep hash ([784c2e2](https://github.com/Creator54/awrit/commit/784c2e26674a907b914cdce7f9ea619e35107dd0))
* **error-pages:** add go back, retry, and open in browser actions to error pages ([780027f](https://github.com/Creator54/awrit/commit/780027fba020f97c749e2321c880ff68ef00c2b2))
* **flake:** add flake.nix for nix profile install/uninstall ([952c962](https://github.com/Creator54/awrit/commit/952c962188fde56d1ce91a4d60f12abf96be76f7))
* force dark mode + reduce paint suppression to 200ms ([680fe8e](https://github.com/Creator54/awrit/commit/680fe8ee39a97bc48490426bb750f9ec22576e9f))
* implement find in page UI and functionality ([012f354](https://github.com/Creator54/awrit/commit/012f3543c79c8926dbe182fb3a798f1fa31ef222))
* implement system browser OAuth and enhance anti-detection ([6774ca0](https://github.com/Creator54/awrit/commit/6774ca0b4f82b957b990ee3dbf26e3894333568d))
* implement transparent app-centric auth bridge ([6cbd7fa](https://github.com/Creator54/awrit/commit/6cbd7fae417d9d5146f2ba41c85929a61d390889))
* improve URL resolution and search responsiveness ([d745168](https://github.com/Creator54/awrit/commit/d7451688e37542f053080786cfd57b451ac1ecfc))
* **input:** change global find shortcut from ctrl+f to alt+/ ([971633e](https://github.com/Creator54/awrit/commit/971633efcac012af74f2e32cc245f593624a406c))
* **input:** implement 2-finger horizontal scroll navigation ([e5ddffe](https://github.com/Creator54/awrit/commit/e5ddffe7afa2b0a77478597184b096c75a9623da))
* lazy load toolbar and support urlBar.defaultVisible config ([4290da9](https://github.com/Creator54/awrit/commit/4290da9f861ee348b8ca3e177e4deeb3f3160942))
* move logs to standard data directory (~/.local/share/awrit) ([5e115dd](https://github.com/Creator54/awrit/commit/5e115dd6e249efad8b1847e70a34b2ad97a5a4dd))
* **nav:** native navigation overlay and terminal security hardening ([6b880ed](https://github.com/Creator54/awrit/commit/6b880ed6ded55007da968505ccc4c7b9cbd4f96b))
* **omnibox:** intelligent suggestions, keyboard navigation, and Zen-inspired UI ([4c8291f](https://github.com/Creator54/awrit/commit/4c8291fd32c1fc117b5259c26ebd382cc02780dd))
* optimize memory and rendering while ensuring stability ([ac77a00](https://github.com/Creator54/awrit/commit/ac77a00b1d319d1f29d2551ca662c7712999d9ee))
* **plugin:** Claude chat plugin and awrit skill ([6fb13cd](https://github.com/Creator54/awrit/commit/6fb13cdf942677bea091ec803ec09b206dc47d36))
* rebind copy/paste and quit shortcuts ([eed1489](https://github.com/Creator54/awrit/commit/eed14894d85649a9bc282caa027f087d7df2ccee))
* **security:** implement interactive site permission prompts and omnibox controls ([b0d2ea9](https://github.com/Creator54/awrit/commit/b0d2ea9959edd863ed13403af0fa2817c639d18c))
* **shader:** add opt-in CPU post-processing bitmap shaders ([388d7a5](https://github.com/Creator54/awrit/commit/388d7a545529c5e43fca4edf096a93080739c9d2))
* shared browser owner, agent tools, design mode, Android and remote ([0cda34f](https://github.com/Creator54/awrit/commit/0cda34f54e0b1a8d027e6590b5c5cfd39cf17120))
* support standard terminal copy shortcuts and improve stability ([0e183f4](https://github.com/Creator54/awrit/commit/0e183f4840b020bfeaf77d5e370318a549ad4ccd))
* **terminal:** optimize resize performance and fix blank repaint artifacts ([bd59a18](https://github.com/Creator54/awrit/commit/bd59a18d6dc39b627aaad323952d074319756968))
* **tty:** add placement replacement helper for Kitty graphics ([fb04e66](https://github.com/Creator54/awrit/commit/fb04e66fbf160015e13f5afa733e9c58e374334c))
* **ui:** add --no-url-bar flag for minimalist startup ([1149601](https://github.com/Creator54/awrit/commit/1149601668dd010c50537b15737348f7ec45f3ac))
* **ui:** URL bar toggling and layout engine fixes ([6f7e7d4](https://github.com/Creator54/awrit/commit/6f7e7d458ff8485e7cd9123c5f4f6fd9ab6f255a))
* universal auth bridge with multi-platform deep-linking ([fb11514](https://github.com/Creator54/awrit/commit/fb11514b4f3da1ea6827a2947139beb5d19a1ed1))
* use native OS clipboard binaries for copy/paste ([4fa9a4c](https://github.com/Creator54/awrit/commit/4fa9a4cdd06fe39169d18b8815614feea75768c6))
* website click-to-copy support ([6f6d1ba](https://github.com/Creator54/awrit/commit/6f6d1baff98f6880ce36b104a60303b1847fb027))
* **windows:** integrate zoom persistence, IPC bridge handlers, and build version hashing ([8090e00](https://github.com/Creator54/awrit/commit/8090e00f3a12e8d2b8ea397c1bc898b24465bfa9))


### Fixes

* allow Google login in embedded browser ([2de107c](https://github.com/Creator54/awrit/commit/2de107c54efd3bece567c141567d8f9f312d2977))
* change help shortcut to Alt+H to allow typing '?' into websites and update UI ([867013b](https://github.com/Creator54/awrit/commit/867013bc1d26940b9e3d28158fb8f840941a7ede))
* decouple Escape from Ctrl+[ and add Alt+Left/Right shortcuts ([b663690](https://github.com/Creator54/awrit/commit/b66369097673899f0336337f4c64233324c68602))
* externalize awrit-native-rs in bundle; add uninstall to install.sh ([8f3b06e](https://github.com/Creator54/awrit/commit/8f3b06e26fc840eb0ac8202812d871bc0a60000f))
* guard Flash Killer whiteness check with isSuppressingPaint ([a2351c4](https://github.com/Creator54/awrit/commit/a2351c4b8dee17e8b095fa196c8e0dea8c947356))
* implement active mouse button tracking for drag modifiers ([06c0ca7](https://github.com/Creator54/awrit/commit/06c0ca702954de02d7636a2eee3bbdfb0f891fb7))
* implement bidirectional clipboard sharing using OSC 52 and bracketed paste ([f3dc414](https://github.com/Creator54/awrit/commit/f3dc4148a0a1aeedfd45166d0e56d330bc4a82cb))
* implement zero-latency navigation swap to eliminate white flashes ([207e982](https://github.com/Creator54/awrit/commit/207e9824258e0f6e5e7901f5f0f767851f398171))
* **input:** correct mouse modifier casing for drag and drop ([df803f8](https://github.com/Creator54/awrit/commit/df803f8c18de84f8874fa6083ae6002014953d2a))
* **input:** improve view recovery, drag setup, and omnibox scroll routing ([d649eee](https://github.com/Creator54/awrit/commit/d649eee4fcd398479b6003ec56c48ee1805d6b62))
* **keybindings:** swallow multi-key binding prefix when browser view is idle ([4477afb](https://github.com/Creator54/awrit/commit/4477afbd1049b89657a5657f7b3615a310ad56ff))
* lazy-load toolbar ([2ce94b4](https://github.com/Creator54/awrit/commit/2ce94b4b6385b26e12838858c2b6e4ff85295791))
* map Ctrl+R to page reload and prioritize reload in omnibox suggestions ([67ba191](https://github.com/Creator54/awrit/commit/67ba191d2fc996aa718852646f376bdcc29077ff))
* merge duplicate disable-features switches into single call ([acff274](https://github.com/Creator54/awrit/commit/acff274e4be0d616bc2f8fb815400927c95f2cae))
* multi-windows seems working ([1137a5b](https://github.com/Creator54/awrit/commit/1137a5bed63a4714ab18519e609b0a03fb36ff42))
* **navigation:** retry original URL on reload when error page is active ([92d96c5](https://github.com/Creator54/awrit/commit/92d96c520b34d6f8e6cf615bc6aae463adc9f706))
* **omnibox:** native z-indexed layers, terminal blackout, and reliable toggling ([7f8366c](https://github.com/Creator54/awrit/commit/7f8366c0a64e0e8c2d2bc790bc15b1fce9518489))
* prevent double Escape toggle by consolidating logic in global listener ([5284992](https://github.com/Creator54/awrit/commit/528499292356e142f38dcf671c7c3b3299ed358e))
* recognize IFRAME and CANVAS as inputs for pass-through mode ([6f37ca9](https://github.com/Creator54/awrit/commit/6f37ca905768e1f3380f3bfc3bd8ea71348f49d0))
* redirect all logs and native stderr to awrit.log ([3ea872f](https://github.com/Creator54/awrit/commit/3ea872f0d3ce7eb1857d7372bebe6a8531e7fc8a))
* remove auth interception placeholder, login works directly in awrit ([8e9ea7f](https://github.com/Creator54/awrit/commit/8e9ea7f31feea6e08aa93e4702f4fec861cb60c9))
* remove broken google OAuth bridge, let login render natively ([62f1170](https://github.com/Creator54/awrit/commit/62f117050a25284e3bc5ec06d286e45959066c73))
* resolve input focus issues and sync UI state at startup ([82d035c](https://github.com/Creator54/awrit/commit/82d035ccbac008b4b1671491b957fac6522d3788))
* resolve offscreen clipboard copying and modifier casing ([84d803c](https://github.com/Creator54/awrit/commit/84d803c8d8b7338f2b4f0b3be56bfb5ff12440f5))
* resolve toolbar build error and finalize progress bar UI ([b6803ad](https://github.com/Creator54/awrit/commit/b6803ad277f962aacb2e46496cb4e21c1f276400))
* resolve zero-size buffer errors and URL bar toggle visual glitches ([9101caa](https://github.com/Creator54/awrit/commit/9101caa84a60f512660e72eb32c83f0acc3188be))
* restore Ctrl+L shortcut and resolve rendering glitches ([2a99312](https://github.com/Creator54/awrit/commit/2a9931220d38d56d98cb417e7adb41d21ccb6fa8))
* **security:** properly consult site cache for geolocation and notifications ([cbe1de5](https://github.com/Creator54/awrit/commit/cbe1de57a3106343aa413adc34406fd388b3f21e))
* stabilize omnibox UI and resolve split-resize crashes ([ce7cd78](https://github.com/Creator54/awrit/commit/ce7cd78b966ce6b0466a8c5a77c3c06c67423a4b))
* **ui:** fix CLI flag --no-url-bar being ignored ([f3eb0a5](https://github.com/Creator54/awrit/commit/f3eb0a5deba9863a5333747a018e5e1970bd4127))
* use lowercase leftbuttondown modifiers per Electron API ([65a0295](https://github.com/Creator54/awrit/commit/65a0295a92c47584c32b0f7e5afa6348fa7242a8))
* use native paste instead of insertText for iframe compatibility ([544fa95](https://github.com/Creator54/awrit/commit/544fa95d160a5df70b7d75569020b998267aa7f1))
* **windows:** synchronize layout node dimensions on window resize ([45fde52](https://github.com/Creator54/awrit/commit/45fde523720f9baab4357aac2c4babaa656e96c1))


### Performance

* add memory optimization flags and disable spellchecker ([a5bc62c](https://github.com/Creator54/awrit/commit/a5bc62ce264f66038ad9a4ada5a9c3ff5a1dc8f3))
* cache navigation overlay arrow buffers ([2fa9dff](https://github.com/Creator54/awrit/commit/2fa9dff69e0800c3e1d0b4f615f6e9e24aa097dd))
* consolidate optimizations and ensure regression-free stability ([f397b37](https://github.com/Creator54/awrit/commit/f397b37698cf76e6e6adcda401b2a8d5c5bd5bd3))
* dynamically throttle offscreen framerates (using terminal focus) ([b814007](https://github.com/Creator54/awrit/commit/b814007f69f1dd9300c53628b271d5152e149add))
* eliminate 32MB pre-fill buffer allocations on window resize ([9f6b20a](https://github.com/Creator54/awrit/commit/9f6b20a65535843b33c7a1c34261ca71dad5245d))
* implement input throttling and SIMD pass optimizations ([10c815a](https://github.com/Creator54/awrit/commit/10c815ad44cc2733b5b44b1774ba62e013c83d8c))
* limit offscreen frame rate to 30fps content / 15fps toolbar ([b68bc0e](https://github.com/Creator54/awrit/commit/b68bc0e304a33b2c5f1fd7f41b989f9828ddc7a0))
* optimize BGRA-&gt;RGBA conversion using dirty rects ([bdd4fcc](https://github.com/Creator54/awrit/commit/bdd4fcc156491d1ce5320a0dd2170840cc3ba072))
* optimize video playback and rendering for kitty terminal ([5eea1d8](https://github.com/Creator54/awrit/commit/5eea1d8d1eb0b41aeb7e0fb74e55f62f504a2b32))
* skip chrome extensions init when no extensions configured ([b764918](https://github.com/Creator54/awrit/commit/b764918096f9255191905e31cd14843337be5d32))
* **startup:** aggressive screen clearing and prioritized painting ([56f78d7](https://github.com/Creator54/awrit/commit/56f78d7f83899bccb40de848ab3069ca5450567e))
* switch config watcher from polling to inotify (fs.watch) ([5c7013a](https://github.com/Creator54/awrit/commit/5c7013a4269e620ce03744a7f8240ce3bfdd68f6))

## [2.1.0](https://github.com/Creator54/awrit/compare/v2.0.5...v2.1.0) (2026-11-16)


### Features

* **plugin:** Claude chat plugin and awrit skill ([6fb13cd](https://github.com/Creator54/awrit/commit/6fb13cdf942677bea091ec803ec09b206dc47d36))
* shared browser owner, agent tools, design mode, Android and remote ([0cda34f](https://github.com/Creator54/awrit/commit/0cda34f54e0b1a8d027e6590b5c5cfd39cf17120))


### Fixes

* externalize awrit-native-rs in bundle; add uninstall to install.sh ([8f3b06e](https://github.com/Creator54/awrit/commit/8f3b06e26fc840eb0ac8202812d871bc0a60000f))
