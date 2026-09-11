#!/usr/bin/env python3
"""
singbox-router 托盘 —— 常驻遥控器

刻意**不** import WebKit：那套库一旦载入就常驻约 100MB，而托盘要 7×24 挂着。
面板窗口另起一个进程（app/window.py），关窗即整进程退出，内存一分不留。
托盘常驻只剩约 42MB。

日常操作全部走面板的本地 HTTP API，托盘自己不碰 sing-box。
只有一个例外：需要 root 的三件事（授权 TUN / 清残留 / 重启网络）由托盘直接
pkexec 调 scripts/sbr-helper.sh。原因是面板后端由 systemd --user 托管，
未必看得见图形会话，polkit 授权框可能弹不出来；而托盘本身就是图形程序，
一定弹得出来。网断了面板打不开时，这条路也还在。
"""
import getpass
import json
import os
import shutil
import signal
import subprocess
import sys
import urllib.error
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator

from gi.repository import Gdk, GLib, Gtk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICE = "singbox-router.service"
POLL_SECONDS = 5

ICON_RUNNING_TUN = "network-vpn"
ICON_RUNNING = "network-transmit-receive"
ICON_STOPPED = "network-offline"

# 文件管理器：xdg-open 在各桌面成功率参差，挨个试。
# Mint/Cinnamon 是 nemo，所以它排在 nautilus 前面。与 src/open.js 保持同一条链。
OPENERS = [["xdg-open"], ["gio", "open"], ["nemo"], ["nautilus"], ["thunar"], ["dolphin"], ["caja"], ["pcmanfm"]]


def data_dir():
    """
    数据目录，与 src/store.js 的解析规则一字不差：
    SBR_DATA_DIR > ~/.singbox-router（不放 ~/.cache：里面有订阅 token，清理工具不该碰）
    """
    explicit = os.environ.get("SBR_DATA_DIR")
    if explicit:
        return os.path.abspath(explicit)
    return os.path.join(os.path.expanduser("~"), ".singbox-router")


def state_file():
    """
    托盘可能比面板服务先起来，此时新目录还没被创建（迁移是在 store.load() 里做的）。
    这种情况下退回旧路径读端口，读到就用 —— 只是为了拿一个端口号，不必等迁移。
    """
    primary = os.path.join(data_dir(), "state.json")
    if os.path.exists(primary):
        return primary
    legacy = os.path.join(ROOT, "data", "state.json")
    return legacy if os.path.exists(legacy) else primary


def panel_port():
    """面板端口以磁盘状态为准，用户改过也能跟上"""
    try:
        with open(state_file(), encoding="utf-8") as f:
            return int(json.load(f)["settings"]["webPort"])
    except Exception:
        return 8899


def api(path, method="GET", body=None, timeout=20):
    url = f"http://127.0.0.1:{panel_port()}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        text = r.read().decode()
    return json.loads(text) if text else None


def notify(summary, body=""):
    if shutil.which("notify-send"):
        subprocess.Popen(
            ["notify-send", "-a", "singbox-router", "-i", ICON_RUNNING, summary, body],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def systemctl(*args):
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=30)


HELPER = os.path.join(ROOT, "scripts", "sbr-helper.sh")

# 找内核的顺序与 src/core.js 的 findCore() 保持一致（面板不可用时才走这里）
CORE_CANDIDATES = [
    os.path.join(ROOT, "bin", "sing-box"),
    "/usr/local/bin/sing-box",
    "/usr/bin/sing-box",
    os.path.join(os.path.expanduser("~"), ".local", "bin", "sing-box"),
]


def find_core():
    for p in CORE_CANDIDATES:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which("sing-box")


def tun_defaults():
    """急救要用的网卡名 / 路由表 / 规则索引。面板可能已经打不开了，所以直接读磁盘状态"""
    iface, table, rule = "sbr-tun", 2023, 9100
    try:
        with open(state_file(), encoding="utf-8") as f:
            s = json.load(f)["settings"]
        iface = str(s.get("tunInterface") or iface)
        table = int(s.get("tunTableIndex") or table)
        rule = int(s.get("tunRuleIndex") or rule)
    except Exception:
        pass  # 读不出来就用内置默认值 —— 急救不能因为状态文件坏了就做不了
    return iface, table, rule


def pkexec_helper(args, timeout=180):
    """
    以 root 跑特权助手，弹一次系统授权框。参数会在 sbr-helper.sh 里被 root 侧重新校验一遍。
    """
    if not shutil.which("pkexec"):
        raise RuntimeError("系统里没有 pkexec（policykit-1 未安装），无法申请管理员权限")
    if not os.path.exists(HELPER):
        raise RuntimeError(f"特权助手不在：{HELPER}")
    p = subprocess.run(
        ["pkexec", "/bin/bash", HELPER, *[str(a) for a in args]],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if p.returncode == 0:
        return (p.stdout or "").strip()
    # pkexec 的约定：126 = 用户取消 / 密码不对，127 = 找不到授权代理或程序
    if p.returncode == 126:
        raise RuntimeError("授权被取消，或密码不对")
    if p.returncode == 127:
        raise RuntimeError("找不到图形授权代理（polkit agent 没在跑）")
    tail = [l for l in (p.stderr or p.stdout or "").splitlines() if l.strip()]
    raise RuntimeError("\n".join(tail[-3:]) or f"退出码 {p.returncode}")


# ------------------------------------------------------------------------ 托盘


class Tray:
    def __init__(self):
        self.indicator = AppIndicator.Indicator.new(
            "singbox-router", ICON_STOPPED, AppIndicator.IndicatorCategory.SYSTEM_SERVICES
        )
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.menu = Gtk.Menu()
        self.indicator.set_menu(self.menu)
        self.state = None
        self.reachable = False
        self.window = None
        # 切换节点时会触发刷新，避免刷新回调把用户刚选的项覆盖回去
        self.busy = False
        self.refresh()
        GLib.timeout_add_seconds(POLL_SECONDS, self.tick)

    # ---------------------------------------------------------------- 数据

    def tick(self):
        if not self.busy:
            self.refresh()
        return True

    def refresh(self):
        try:
            self.state = api("/api/state", timeout=6)
            self.reachable = True
        except Exception:
            self.state = None
            self.reachable = False
        self.render()

    # ---------------------------------------------------------------- 渲染

    def render(self):
        for child in self.menu.get_children():
            self.menu.remove(child)

        if not self.reachable:
            self.indicator.set_icon_full(ICON_STOPPED, "面板未运行")
            self.indicator.set_label("", "")
            self.add_item("面板服务未运行", enabled=False)
            self.add_sep()
            self.add_item("启动面板服务", self.on_start_service)
            # 这三条都不经面板：服务没起来、甚至网断了也能用
            self.add_item("打开配置文件夹", self.on_open_config_dir)
            self.add_item("TUN 断网急救（清理残留）", self.on_recover_tun)
            self.add_item("重启网络服务", self.on_restart_network)
            self.add_sep()
            self.add_item("退出", self.on_quit)
            self.menu.show_all()
            return

        st = self.state["status"]
        running = st["running"]
        tun = st.get("tun") or {}
        tun_on = tun.get("enabled") and running
        now = self.state.get("currentProxy") or "—"

        icon = ICON_RUNNING_TUN if tun_on else (ICON_RUNNING if running else ICON_STOPPED)
        self.indicator.set_icon_full(icon, "singbox-router")
        self.indicator.set_label(self.short(now) if running else "", "singbox-router")

        head = f"● 运行中 · {now}" if running else "○ 内核已停止"
        if tun_on:
            head += f"（TUN {tun.get('interface')}）"
        self.add_item(head, enabled=False)

        # 有办法修的问题就做成能点的：点一下当场修，不要让用户去开终端
        issues = []
        if tun.get("enabled") and not running:
            cap = tun.get("capability") or {}
            if not cap.get("ok"):
                if cap.get("reason") == "no-core":
                    issues.append(("还没有内核 —— 点这里下载", self.on_download_core))
                else:
                    issues.append(("TUN 权限未就绪 —— 点这里授权", self.on_authorize_tun))
            for c in tun.get("conflicts") or []:
                issues.append((f"冲突：{c['name']}（请先退出它）", None))
        # 残留与 tunEnabled 无关：它意味着"现在整机可能上不了网"，永远要显眼且可点
        for s in tun.get("stale") or []:
            issues.append((f"残留 {s} —— 点这里清理", self.on_recover_tun))
        if st.get("dirty"):
            issues.append(("配置已变更，待应用", self.on_apply))
        for text, handler in issues:
            self.add_item(f"  ⚠ {text}", handler)

        self.add_sep()
        self.add_item("打开面板", self.on_open_panel)
        self.add_item("问题排查…", self.on_doctor)
        self.add_item("打开配置文件夹", self.on_open_config_dir)

        self.add_sep()
        if running:
            self.add_item("停止内核", self.on_stop_core)
            self.add_item("重启内核", self.on_restart_core)
        else:
            self.add_item("启动内核", self.on_start_core)
        if st.get("dirty"):
            self.add_item("应用配置", self.on_apply)

        if running:
            self.add_sep()
            self.add_submenu(
                "主端口节点",
                [("auto", "自动选择最快")]
                + [
                    (n["tag"], n["tag"])
                    for n in self.state["nodes"]
                    if n.get("enabled") and n.get("kind") != "direct"
                ],
                now,
                self.on_select_node,
            )
            self.add_submenu(
                "分流模式",
                [("rule", "规则"), ("global", "全局代理"), ("direct", "全局直连")],
                self.state.get("clashMode"),
                self.on_select_mode,
            )

        directs = [n for n in self.state["nodes"] if n.get("kind") == "direct" and n.get("enabled")]
        if directs:
            self.add_sep()
            for n in directs:
                self.add_item(f"直连端口 {n['port']}（点击复制）", self.on_copy_port, n["port"])

        # 维护：原先要开终端跑 scripts/*.sh 的那几件事，这里全都是一次点击
        self.add_sep()
        maint = self.add_plain_submenu("维护")
        self.add_item("下载 / 更新内核", self.on_download_core, menu=maint)
        self.add_item("下载 / 更新规则集", self.on_download_rulesets, menu=maint)
        self.add_item("一次性授权 TUN", self.on_authorize_tun, menu=maint)
        self.add_item("TUN 断网急救（清理残留）", self.on_recover_tun, menu=maint)
        self.add_item("重启网络服务", self.on_restart_network, menu=maint)

        # 终端代理：gsettings 那套系统代理命令行工具一概不认，得单独挂环境变量
        tp = self.state.get("termProxy") or {}
        if tp.get("managed"):
            self.add_item("取消接管终端代理", self.on_termproxy_off, menu=maint)
        else:
            self.add_item("接管终端代理（新开的终端生效）", self.on_termproxy_on, menu=maint)
        self.add_item("复制终端代理命令（给已开着的终端）", self.on_copy_term_line, menu=maint)

        self.add_item("复制诊断报告", self.on_copy_report, menu=maint)

        self.add_sep()
        self.add_item("退出（不影响内核）", self.on_quit)
        self.menu.show_all()

    def short(self, text, limit=18):
        text = str(text)
        return text if len(text) <= limit else text[: limit - 1] + "…"

    def add_item(self, label, handler=None, arg=None, enabled=True, menu=None):
        item = Gtk.MenuItem(label=label)
        if handler:
            item.connect("activate", handler) if arg is None else item.connect("activate", handler, arg)
        item.set_sensitive(bool(handler) and enabled)
        (menu if menu is not None else self.menu).append(item)
        return item

    def add_sep(self):
        self.menu.append(Gtk.SeparatorMenuItem())

    def add_plain_submenu(self, title):
        """普通子菜单（add_submenu 那个是单选的，用途不同）"""
        sub = Gtk.Menu()
        holder = Gtk.MenuItem(label=title)
        holder.set_submenu(sub)
        self.menu.append(holder)
        return sub

    def add_submenu(self, title, options, current, handler):
        sub = Gtk.Menu()
        holder = Gtk.MenuItem(label=title)
        holder.set_submenu(sub)
        self.menu.append(holder)
        group = None
        for value, label in options:
            item = Gtk.RadioMenuItem(label=label, group=group)
            group = group or item
            item.set_active(value == current)
            item.connect("toggled", handler, value)
            sub.append(item)

    # ---------------------------------------------------------------- 动作

    def act(self, label, fn, ok_body=None):
        """
        统一的"点一下、干一件事、弹个通知"。
        ok_body 可以是字符串，也可以是拿 fn() 返回值算提示文案的函数。
        """
        self.busy = True
        try:
            result = fn()
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode()).get("error", str(e))
            except Exception:
                msg = str(e)
            notify(f"{label}失败", msg)
        except Exception as e:
            notify(f"{label}失败", str(e))
        else:
            body = ok_body(result) if callable(ok_body) else (ok_body or "")
            notify(label + "成功", body)
        finally:
            self.busy = False
            self.refresh()

    def on_open_panel(self, _, tab=None):
        """窗口是独立进程：已在跑就激活它，否则拉一个新的"""
        if self.window and self.window.poll() is None:
            if shutil.which("wmctrl"):
                subprocess.run(["wmctrl", "-x", "-a", "singbox-router"], capture_output=True)
            return
        argv = [sys.executable, os.path.join(ROOT, "app", "window.py")]
        if tab:
            argv += ["--tab", tab]
        try:
            self.window = subprocess.Popen(
                argv,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            notify("打开面板失败", str(e))
            self.window = None

    def on_doctor(self, _):
        """开到排查页。已经有窗口在跑时只能激活它 —— 那时用户自己点一下侧边的「问题排查」"""
        self.on_open_panel(None, tab="doctor")

    def on_open_config_dir(self, _):
        """
        托盘一定坐在图形会话里（它自己就是 GTK 程序），所以这条路比面板那个按钮更可靠：
        面板服务由 systemd --user 起，不保证有 DISPLAY，那时 xdg-open 会静默失效。
        先按 which 过滤掉不存在的命令，避免为「命令不存在」白等一轮超时。
        """
        target = data_dir()
        try:
            os.makedirs(target, exist_ok=True)
        except Exception as e:
            notify("打开配置文件夹失败", f"{target}（{e}）")
            return

        tried = []
        for argv in OPENERS:
            if not shutil.which(argv[0]):
                continue
            try:
                proc = subprocess.Popen(
                    [*argv, target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            except Exception as e:
                tried.append(f"{argv[0]}({e})")
                continue
            try:
                code = proc.wait(timeout=1.2)
            except subprocess.TimeoutExpired:
                return  # 还在跑 —— 文件管理器常驻前台，这就是成功的样子
            if code == 0:
                return
            tried.append(f"{argv[0]}(退出码 {code})")

        detail = "、".join(tried) if tried else "系统里没有找到文件管理器"
        self.copy_text(target, quiet=True)
        notify("打不开文件管理器，路径已复制", f"{target}\n{detail}")

    def on_start_core(self, _):
        self.act("启动内核", lambda: api("/api/core/start", "POST", timeout=60))

    def on_stop_core(self, _):
        self.act("停止内核", lambda: api("/api/core/stop", "POST", timeout=60))

    def on_restart_core(self, _):
        self.act("重启内核", lambda: api("/api/core/restart", "POST", timeout=90))

    def on_apply(self, _):
        self.act("应用配置", lambda: api("/api/core/apply", "POST", timeout=90))

    # ---------------------------------------------------- 维护（原来的 sh 脚本）

    def on_download_core(self, _):
        # 下载 + 解包 + 落盘都在面板后端做，这里只是按一下。超时给够：内核 20MB 左右
        self.act("下载内核", lambda: api("/api/core/download", "POST", {}, timeout=300))

    def on_download_rulesets(self, _):
        self.act("下载规则集", lambda: api("/api/rulesets/update", "POST", {}, timeout=180))

    def on_authorize_tun(self, _):
        """
        直接 pkexec，不走面板：托盘一定在图形会话里，授权框弹得出来；
        面板后端由 systemd --user 托管，可能没有 DISPLAY。
        """
        core = ((self.state or {}).get("status") or {}).get("corePath") or find_core()
        if not core:
            notify("授权 TUN 失败", "还没有 sing-box 内核 —— 先点「维护 → 下载 / 更新内核」")
            return
        user = getpass.getuser()
        self.act("授权 TUN", lambda: pkexec_helper(["authorize-tun", core, user]))

    def on_recover_tun(self, _):
        iface, table, rule = tun_defaults()
        self.act("清理 TUN 残留", lambda: pkexec_helper(["recover-tun", iface, table, rule], timeout=150))

    def on_restart_network(self, _):
        self.act("重启网络服务", lambda: pkexec_helper(["restart-network"], timeout=150))

    # ------------------------------------------------------------- 终端代理

    def on_termproxy_on(self, _):
        """
        往 shell 启动脚本里挂一段 source。**只对以后新开的终端生效** ——
        一个进程改不了另一个进程的环境变量，所以提示里必须给出那行手动命令，
        不能让用户以为点完当前终端就通了。
        """
        self.act(
            "接管终端代理",
            lambda: api("/api/termproxy", "POST", {"on": True}, timeout=30),
            lambda r: "以后新开的终端自动走代理。已经开着的终端里执行一次：\n"
            + ((r or {}).get("sourceLine") or ""),
        )

    def on_termproxy_off(self, _):
        self.act(
            "取消接管终端代理",
            lambda: api("/api/termproxy", "POST", {"on": False}, timeout=30),
            "已按标记摘掉插入的那段，你自己写的行没动过。已开着的终端里可以 proxyoff。",
        )

    def on_copy_term_line(self, _):
        """给已经开着的终端用的一行。状态里就有，拿不到再问一次面板"""
        line = ((self.state or {}).get("termProxy") or {}).get("sourceLine")
        if not line:
            try:
                line = (api("/api/termproxy", timeout=15) or {}).get("sourceLine")
            except Exception as e:
                notify("获取终端代理命令失败", str(e))
                return
        if not line:
            notify("获取终端代理命令失败", "面板没有返回内容")
            return
        if self.copy_text(line, quiet=True):
            notify("命令已复制", "粘到已经开着的终端里执行一次即可")

    def on_copy_report(self, _):
        """把排查报告拷进剪贴板 —— 里面不含节点地址、订阅链接、密码，可以直接贴出去求助"""
        try:
            text = (api("/api/doctor", timeout=60) or {}).get("text") or ""
        except Exception as e:
            notify("生成诊断报告失败", str(e))
            return
        if not text:
            notify("生成诊断报告失败", "面板没有返回内容")
            return
        if self.copy_text(text, quiet=True):
            notify("诊断报告已复制", "不含节点地址与密码，可直接粘贴求助")

    def on_select_node(self, item, name):
        if not item.get_active() or self.busy:
            return
        self.act(f"切换到 {name}", lambda: api("/api/proxy/select", "POST", {"name": name}))

    def on_select_mode(self, item, mode):
        if not item.get_active() or self.busy:
            return
        self.act(f"切换模式 {mode}", lambda: api("/api/mode", "POST", {"mode": mode}))

    def copy_text(self, text, quiet=False):
        """复制到剪贴板。quiet=True 表示提示由调用方自己发，避免弹两条通知"""
        try:
            cb = Gtk.Clipboard.get_default(Gdk.Display.get_default())
            cb.set_text(text, -1)
            cb.store()
        except Exception as e:
            if not quiet:
                notify("复制失败", f"{text}（{e}）")
            return False
        if not quiet:
            notify("已复制", text)
        return True

    def on_copy_port(self, _, port):
        self.copy_text(f"http://127.0.0.1:{port}")

    def on_start_service(self, _):
        r = systemctl("start", SERVICE)
        if r.returncode != 0:
            notify("启动面板服务失败", (r.stderr or "").strip()[:200])
        self.refresh()

    def on_quit(self, _):
        Gtk.main_quit()


def main():
    tray = Tray()

    def open_window():
        tray.on_open_panel(None)
        return False

    # 单实例：已在运行时，启动器发 SIGUSR1 让这个进程开窗，
    # 而不是再起一个托盘（否则会冒出第二个图标）。
    # 托盘进程不载入 WebKit，所以不会和 WebKit 的 GC 信号相撞。
    def on_sigusr1():
        GLib.idle_add(open_window)
        return True

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, on_sigusr1)

    if "--window" in sys.argv:
        GLib.idle_add(open_window)
    Gtk.main()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
