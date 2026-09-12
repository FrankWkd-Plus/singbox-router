# singbox-router

A [sing-box](https://github.com/SagerNet/sing-box) client whose core idea is one sentence:

> **Every node gets its own local port — point a program at a port and its traffic always exits through that node.**

Zero npm dependencies (pure Node stdlib), a single-page web panel, plus an optional desktop app (WebKitGTK, **not** Electron).

Chinese docs are the primary reference: **[README.md](README.md)**.

---

## Why ports instead of rules

Mainstream clients split traffic by *guessing*: domain matching, GEOIP, process names. Two problems:

1. **A miss is silent.** A domain your rule set doesn't cover exits through the wrong node and nothing tells you.
2. **It isn't observable.** You can't directly answer "which node is this program using right now?"

This project makes the unit a port, chosen explicitly by you:

```
                     ┌── :7890   main port ────────→ proxy selector (chosen node / urltest)
                     │
                     ├── :20801  HK 01 ────────────→ always exits via Hong Kong
   your programs ────┼── :20802  JP 02 ────────────→ always exits via Japan
                     ├── :20803  [DIRECT] ─────────→ never proxied, in any mode
                     │
                     └── sbr-tun device (TUN) ─────→ proxy selector, captures everything
```

So splitting becomes deterministic:

```bash
git  config --global http.proxy http://127.0.0.1:20801   # git via Hong Kong
npm  config set proxy            http://127.0.0.1:20802   # npm via Japan
export https_proxy=http://127.0.0.1:20803                 # this shell goes direct
```

Every port is a `mixed` inbound, so **HTTP and SOCKS5 share the same port** — `socks5://127.0.0.1:20802` works too.

Rules aren't the problem; *only* having rules is. So ports are the default unit and rules are an optional layer: custom rules (process / IP / website, regex supported) and China auto-direct can both be enabled, but they always rank below port bindings — nothing you chose explicitly gets overridden by a guess.

For the mechanism (route rule ordering, and why port bindings must outrank the mode switch) see **[docs/splitting.md](docs/splitting.md)**.

---

## Quick start

Requires **Node >= 20** and **sing-box >= 1.12** (the generated config uses the 1.12 schema: new DNS server format, `action` fields; older cores fail to start on unknown fields).

```bash
git clone https://github.com/FrankWkd-Plus/singbox-router.git
cd singbox-router

bash scripts/get-core.sh        # downloads the core to ./bin/sing-box
node server.js                  # start the panel
```

Open <http://127.0.0.1:8899> → add nodes via *Subscription* or *Import* → click *Start*.

All runtime data (state, subscription tokens, node credentials, rule sets) is written to **`~/.config/singbox-router`**, not the program directory — the repository is desensitized by construction and `git status` stays clean. *Settings → data directory* in the panel and the tray menu both have *Open config folder*. State from older installs under `data/` is **copied** over on first start (the original is left in place).

If the download is blocked:

```bash
SB_MIRROR=https://ghfast.top/ bash scripts/get-core.sh
https_proxy=http://127.0.0.1:7890 bash scripts/get-core.sh
```

You can also point *Settings → core path* at an existing sing-box binary.

### Install as a desktop app

Start-menu entry + resident tray + autostart on login. Two ways:

```bash
# Debian / Ubuntu / Mint: build the package, then install it
bash scripts/build-deb.sh
sudo apt install ./dist/singbox-router_1.0.0-1_all.deb
singbox-router-get-core          # the core isn't in the package (tens of MB, per-arch, needs its own setcap)

# Or, without dpkg: install as a per-user integration
bash scripts/install-app.sh
```

Don't use both — the two installs use the same service and autostart filenames, and the copy in your home directory shadows the system one, which leaves the `.deb`'s copy inert. Data lives in `~/.config/singbox-router` either way, so switching install methods keeps your nodes. Details in **[docs/desktop.md](docs/desktop.md)**.

---

## Features

| | What it does | More |
| --- | --- | --- |
| **Per-node ports** | Assigned from `20800` upward; editable, or renumber in one click | [splitting](docs/splitting.md) |
| **Virtual [DIRECT] node** | A pseudo node that only occupies a local port — traffic through it **stays direct in every mode** | [splitting](docs/splitting.md#虚拟直连节点) |
| **Subscriptions** | Fetched by User-Agent, synced incrementally (gone nodes removed, surviving nodes keep their assigned ports) | [reference](docs/reference.md#订阅) |
| **Multi-format import** | base64 subscriptions / 8 share-link schemes / Clash YAML / sing-box JSON / a JS object literal | [reference](docs/reference.md#支持导入的格式) |
| **System proxy takeover** | Via `gsettings`; the previous values are backed up to disk first, and restored automatically if the core dies | [reference](docs/reference.md#系统代理接管) |
| **TUN mode** | Captures programs that ignore the system proxy (Telegram, CLI tools). No root, no password prompts | [tun](docs/tun.md) |
| **Custom rules** | Process / IP / website; domains and process paths **support regex**; list order is priority | [splitting](docs/splitting.md#自定义分流规则) |
| **China auto-direct** | Optional. GeoIP + GeoSite hits go direct; rule sets are downloaded to disk first, then referenced | [splitting](docs/splitting.md#国内自动分流) |
| **Config directory** | State, credentials and rule sets all live in `~/.config/singbox-router` — no sensitive data in the program directory | [reference](docs/reference.md#目录结构) |
| **Desktop app** | systemd user service + tray + WebKitGTK window, 182MB resident; can be built as a `.deb` | [desktop](docs/desktop.md) |
| **HTTP API** | What the panel itself uses; loopback-only, with Host / Origin validation | [reference](docs/reference.md#http-api) |

### Automatic splitting is an opt-in layer, not the default

An earlier version used **remote** geo rule sets (`.srs`) for "domestic traffic goes direct". In practice **the rule sets were never downloaded successfully** (0.03s startup, no rule-set log lines, `cache.db` never grew) — the toggle was wired to nothing.

The fix was to close that hole, not to drop the feature:

- **Download first, then reference.** Click *Download / update rule sets* in the panel; you see the file size and timestamp, and the generated config points at a local absolute path (`type: local`). There is no longer a state where the toggle looks on but isn't.
- **Remote mode still exists, but you have to pick it.** It carries `download_detour: proxy` (the rule sets live outside the GFW — a direct fetch usually fails, which is exactly why the previous version failed silently) and an `update_interval`.
- **Still off by default.** With it off the config contains zero `.srs` references, so there is **no startup-time download dependency** and it starts offline.

In priority terms, auto-direct is the *last* guess: port binding → mode switch → your custom rules → private addresses → China auto-direct → everything else proxied. Every layer above it is more precise, so it can never override an explicit choice.

Private addresses (`ip_is_private`) and intranet suffixes like `.local` / `.lan` always stay direct, using sing-box's own checks — nothing is downloaded.

---

## Default ports

| Purpose | Port |
| --- | --- |
| Web panel | 8899 |
| Main proxy port | 7890 |
| Clash API | 19090 |
| Per-node ports | 20800 upward |

All configurable. Occupancy is checked before start, and a conflict report names the port and the process holding it.

---

## Docs

The topic docs are in Chinese; this page is the English overview.

| | |
| --- | --- |
| [docs/splitting.md](docs/splitting.md) | Splitting mechanism: route rule ordering, virtual direct node, practical usage |
| [docs/tun.md](docs/tun.md) | TUN: password-free authorization, three pre-flight checks, route table indices, DNS, recovery |
| [docs/desktop.md](docs/desktop.md) | Desktop app: process architecture, measured memory, autostart, graceful shutdown |
| [docs/reference.md](docs/reference.md) | Import formats, HTTP API, settings, self-test, directory layout |

---

## Verified on

Linux Mint 22.3 / Cinnamon / Node 22 / **sing-box 1.13.18**:

- `npm test` — **77 assertions** (both the proxy-utils path and the built-in parser path). The assertions added for custom rules and geo splitting haven't been run on hardware yet; results will be filled in after that run.
- `sing-box check` accepts the generated config in all three shapes (proxy-only / TUN / with a direct node)
- **Per-node splitting works**: 5 ports produced 5 distinct exit IPs
- **The virtual [DIRECT] node works**: its port exits via the real ISP address while proxy ports simultaneously show datacenter IPs
- **Port bindings outrank the mode switch**: tested in all three modes (`rule` / `global` / `direct`), no binding was overridden
- **Rootless TUN works**: the core runs as a normal user (`setcap`), no program is configured with a proxy, and global traffic plus DNS behave normally
- **polkit scope is tight**: `pkcheck` confirms the four `resolve1` actions are allowed while a control action still requires authorization
- System proxy takeover → restore leaves all 11 gsettings keys byte-identical to their pre-takeover values
- Crash recovery: restarting the panel with a leftover takeover state detects the backup and restores it
- Port conflict validation; cross-site / forged-Host requests rejected (403); path traversal rejected

> Troubleshooting note: on a direct path, `1.1.1.1` and Cloudflare-hosted endpoints (including `api.ipify.org`) may time out or get RST. That's link interference, not this program. To verify a direct route, use a domestic target such as `myip.ipip.net` or `cip.cc`.

**Not yet run on hardware:** custom split rules, China auto-direct, *open config folder*, the data-directory migration, and `.deb` packaging. The code and assertions are written but haven't been executed; results will be filled in after that run. Until then, treat them as unverified.

---

## Known limitations

- **TUN needs sudo once** (`setup-tun.sh` grants the capability). Starting and stopping never asks again. Proxy-only mode needs no root at all.
- **IP rules have no regex.** sing-box matches IPs through a radix trie over 32/128-bit integers — there is nowhere in the core for a regex to run, so IP rules take CIDRs only (a bare IP is auto-completed to `/32` or `/128`). Domain and process-path regex are natively supported.
- **Regex is Go RE2**: no lookahead/lookbehind, no backreferences, and named groups are spelled `(?P<name>…)` rather than `(?<name>…)`. Unsupported constructs are rejected **when you save**, not when the core fails to start.
- **Auto-direct is off by default** and is the last fallback layer. For precise control, use port bindings or custom rules.
- **No ShadowsocksR** (sing-box removed it). WireGuard became an endpoint in sing-box 1.11+, so importing it from a link isn't supported yet.
- System proxy takeover **only implements the gsettings path**. On KDE or a bare WM, use the generated `proxy-env.sh`, or just use TUN.
- The panel has **no authentication** and listens on loopback only. **Do not port-forward 8899.**
- Developed and verified on Linux desktops only. TUN and system proxy handling are Linux-specific.

---

## License

[MIT](LICENSE)
