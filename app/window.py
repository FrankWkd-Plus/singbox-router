#!/usr/bin/env python3
"""
面板窗口 —— 独立进程，用完即退

为什么独立成一个进程：
  WebKit 的库一旦 import 进来就常驻（约 100MB 映射），即使销毁 webview 也不释放。
  托盘要 7×24 挂着，不能背这个包袱。所以窗口单独起一个进程，
  关窗即整进程退出，内存一分不留 —— 托盘常驻只剩约 42MB。
  顺带还避开了 WebKit 用 SIGUSR1 做 GC、与托盘的开窗信号相撞的问题。

用 WebKitGTK 而不是 Chromium/Electron：渲染的是同一套面板 UI，外观一行不改。
"""
import os
import sys

# 必须在 import WebKit 之前设置：关掉合成器与 dmabuf 渲染，
# 本地面板不需要 GPU 通路，能省掉一块显存映射和一个中间层
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2

APP_ID = "singbox-router"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def panel_port():
    """端口以磁盘状态为准。解析规则与 src/store.js、app/gui.py 保持一致"""
    import json

    explicit = os.environ.get("SBR_DATA_DIR")
    if explicit:
        base = os.path.abspath(explicit)
    else:
        base = os.path.join(os.path.expanduser("~"), ".singbox-router")

    # 面板还没迁移过（新目录不存在）时退回旧路径，只是为了拿一个端口号
    for candidate in (os.path.join(base, "state.json"), os.path.join(ROOT, "data", "state.json")):
        try:
            with open(candidate, encoding="utf-8") as f:
                return int(json.load(f)["settings"]["webPort"])
        except Exception:
            continue
    return 8899


def tune(settings):
    """按「只渲染一个本地面板」裁掉用不到的子系统"""
    off = [
        "enable-webgl",
        "enable-media",
        "enable-webaudio",
        "enable-media-stream",
        "enable-page-cache",
        "enable-offline-web-application-cache",
        "enable-html5-database",
        "enable-html5-local-storage",
        "enable-developer-extras",
        "enable-back-forward-navigation-gestures",
        "enable-fullscreen",
        "enable-media-capabilities",
        "enable-encrypted-media",
        "enable-dns-prefetching",
        "javascript-can-open-windows-automatically",
    ]
    for prop in off:
        try:
            settings.set_property(prop, False)
        except Exception:
            pass  # 不同 webkit 版本属性有出入，缺哪个跳过哪个
    try:
        settings.set_property("hardware-acceleration-policy", WebKit2.HardwareAccelerationPolicy.NEVER)
    except Exception:
        pass
    try:
        settings.set_property("default-font-family", "system-ui")
    except Exception:
        pass


class Window(Gtk.Window):
    def __init__(self, tab=None):
        super().__init__(title="singbox-router")
        self.set_default_size(1180, 780)
        self.set_icon_name("network-vpn")

        # cookie 与缓存只在内存，退出即无痕，也省磁盘 IO
        ctx = WebKit2.WebContext.new_ephemeral()
        ctx.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)

        self.view = WebKit2.WebView.new_with_context(ctx)
        tune(self.view.get_settings())
        # #tab 由前端读 location.hash 后切页 —— 托盘的「问题排查…」直接开到那一页
        url = f"http://127.0.0.1:{panel_port()}"
        if tab:
            url += f"#{tab}"
        self.view.load_uri(url)

        self.add(self.view)
        self.connect("destroy", lambda *_: Gtk.main_quit())
        self.show_all()


def main():
    # WM_CLASS 两个字段都要设：instance 用 set_prgname，class 用 set_program_class。
    # 只设前者的话 class 会被 GTK 推成 "Window.py"，任务栏就认不出这是同一个应用。
    GLib.set_prgname(APP_ID)
    Gdk.set_program_class(APP_ID)
    GLib.set_application_name("singbox-router")

    tab = None
    if "--tab" in sys.argv:
        i = sys.argv.index("--tab")
        if i + 1 < len(sys.argv):
            # 只收白名单里的页名：这个值最终会拼进 URL 的 fragment
            candidate = sys.argv[i + 1]
            if candidate in ("nodes", "subs", "import", "rules", "settings", "logs", "doctor"):
                tab = candidate

    Window(tab)
    Gtk.main()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
