# Nyra design

Design sources and reference shots for every Nyra surface.

| Folder | What's inside |
| --- | --- |
| `mocks/` | Rendered design mocks: Android, iOS, Mac, Windows |
| `source/` | HTML/CSS sources for the mocks plus render scripts (`kit.py` holds the LIGHT/DARK tokens, `desktop.py` / `mobile.py` the layouts) |
| `terminal/` | Terminal UI (gradient wordmark, mode badges, status bar), English and Chinese |
| `desktop/` | Desktop UI (`nyra ui` at `/`) as implemented at 1440×900: light, dark and Chinese shots; `d2-vs-design.png` (Mac / Windows mocks vs implementation), `d2-splash-vs-video.png` (splash in the desktop shell vs the original video), and liquid glass before/after (`d2-glass-cmp-light.png`, `d2-glass-cmp-dark.png`) |
| `mobile/` | Phone page `/m` as implemented, Android and iOS, plus side-by-side comparisons with the mocks and the splash; liquid glass before/after in `m3-glass-cmp-light.png` / `m3-glass-cmp-dark.png` |
| `splash/` | Opening animation: source, final frame, video |
| `logo/` | Logo explorations and marks |

## Liquid glass

Desktop and phone keep the black-and-white palette and the mock layouts; only the floating layers are glass. Desktop: sidebar, top bar, status bar, composer, approval card, review panel (Diff / Plan / Evidence / Terminal), dialogs, menus and toasts. Phone: tab bar, top bar once scrolled, approval sheet, New thread button, menus, toasts and composer. Glass is a translucent fill with `backdrop-filter` blur and saturation, a 1px top highlight and a soft inner glow, in plain CSS. On the desktop the top bar, status bar and composer float over the thread, so messages scroll underneath them. With `prefers-reduced-transparency` or no `backdrop-filter` support, every layer falls back to solid colour.

Secondary and tertiary text on glass uses darker tokens in light mode and lighter ones in dark mode. Contrast was measured on screenshots, sampling the pixels behind each text element, and every text element on desktop glass is at least 4.5:1 (WCAG AA).
