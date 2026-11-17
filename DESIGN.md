# DESIGN.md — Octa-Analyzer Design System

Document specification for AI coding agents to maintain visual consistency across all PWA views (Crypto Radar & ZTE Wi-Fi Gateway).

---

## 1. Visual Theme & Atmosphere
- **Theme Identity:** VoltAgent Void-Black / High-Density Developer Chrome
- **Atmosphere:** Dark, precise, technical, monospace-forward data display, zero decorative fluff (no emoji templates).
- **Primary Canvas:** `#0d1117` (Void Black)
- **Elevated Surface:** `#161b22` (Panel Surface)
- **Subtle Surface:** `#21262d` (Card & Control Background)
- **Border Frame:** `#30363d` (1px Solid High-Contrast Grid)

---

## 2. Color Palette & Functional Roles
| Token Name | Hex Code | Functional Role |
| :--- | :--- | :--- |
| `--bg-canvas` | `#0d1117` | Root viewport background |
| `--bg-surface` | `#161b22` | Header, panels, modal cards |
| `--bg-subtle` | `#21262d` | Button default, table header, pill background |
| `--border-default` | `#30363d` | Component borders, divider lines |
| `--accent-emerald` | `#10b981` | Bullish signals, active Wi-Fi nodes, success state |
| `--accent-cyan` | `#06b6d4` | Primary brand accent, active tabs, system info |
| `--accent-blue` | `#58a6ff` | Navigation links, interactive highlights |
| `--status-rose` | `#f85149` | Bearish signals, ACL Deny, error states |
| `--status-amber` | `#d29922` | Neutral signals, warning notices, pending sync |
| `--text-primary` | `#f0f6fc` | Headings, primary values, active text |
| `--text-secondary` | `#8b949e` | Labels, table headers, subheadings |
| `--text-muted` | `#6e7681` | Timestamps, MAC addresses, disabled states |

---

## 3. Typography Hierarchy
- **UI & Headings:** `'Inter'`, -apple-system, sans-serif
- **Data, Signals & Code:** `'JetBrains Mono'`, monospace

| Element | Font | Size | Weight | Color |
| :--- | :--- | :--- | :--- | :--- |
| App Title / Brand | Inter | 14px | 700 | `#f0f6fc` |
| Section Header | Inter | 12px | 600 (Uppercase) | `#8b949e` |
| Numeric KPI Value | JetBrains Mono | 20px | 700 | Dynamic Accent |
| Table Header | JetBrains Mono | 11px | 600 | `#8b949e` |
| Monospace Metadata | JetBrains Mono | 11px | 400 | `#6e7681` |

---

## 4. Component Stylings

### A. Navigation Bar (VoltAgent Chrome)
- Background `#161b22`, Bottom Border 1px `#30363d`.
- Active Tab: Bottom border 2px `#f78166` (GitHub Orange) or `#06b6d4` (Cyan).

### B. Cards & Metric Panels
- Background `#161b22`, Border 1px `#30363d`, Radius `6px`.
- Top Accent Line: 2px solid color matching status (Emerald / Rose / Cyan).

### C. Buttons
- Primary: Background `#21262d`, Border 1px `#30363d`, Text `#f0f6fc`. Hover `#30363d`.
- Danger (ACL Deny): Background `rgba(248,81,73,0.15)`, Border 1px `rgba(248,81,73,0.3)`, Text `#f85149`.
- Success (Restore): Background `rgba(16,185,129,0.15)`, Border 1px `rgba(16,185,129,0.3)`, Text `#10b981`.

### D. Badges & Pills
- Font: `JetBrains Mono`, Size 10px, Padding 2px 7px, Radius 12px.
- Zero emojis. Use SVG 1.5px stroke icons for actions.

---

## 5. Do's and Don'ts
- **DO:** Use crisp 1px borders, monospace typography for technical data (IPs, MACs, Prices, Indicators), and SVG vector icons.
- **DON'T:** Use decorative template emojis, rounded pastel bubbles, or light theme surfaces.
