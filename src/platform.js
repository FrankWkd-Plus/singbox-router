/**
 * 平台常量 —— 全项目唯一的平台判断入口。
 *
 * 用途见 docs（跨平台路线）：macOS / Windows 第一期只跑核心面板
 * （节点 / 订阅 / 规则 / 每节点端口 / 进程树选择器），TUN、系统代理接管、
 * 托盘、开机自启这些深度集成后续迭代。各模块按这几个常量门控，
 * 不直接写 process.platform 字符串 —— 改判定时只动这一个文件。
 */
export const PLATFORM = process.platform

export const IS_LINUX = PLATFORM === 'linux'
export const IS_MAC = PLATFORM === 'darwin'
export const IS_WIN = PLATFORM === 'win32'

/** 给 UI / doctor 报告用的友好名 */
export const PLATFORM_LABEL =
  { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[PLATFORM] || PLATFORM
