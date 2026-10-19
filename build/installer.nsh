# Windows 上的 ctoe:// 门铃注册。
#
# electron-builder 的 `protocols` 配置只喂给 macOS（Info.plist 的 CFBundleURLTypes）、Linux（.desktop 的
# MimeType）和 Appx 三个 target —— NSIS / portable 那条路它不写注册表（在 app-builder-lib 里搜一遍
# `protocols` 就能看到：electronMac.js、LinuxTargetHelper.js、AppxTarget.js，没有 NsisTarget）。
# 所以安装程序在这里自己写一次，和 perMachine: false 的按用户安装一样落在 HKCU，不需要管理员权限。
#
# 应用启动时还会用 app.setAsDefaultProtocolClient() 再注册一次（便携版和开发态不经过安装程序，只能靠
# 那一次）。两条路写的是同一个键，谁先谁后都一样，重复写不产生第二个处理器。
#
# 这里注册的只是「谁来打开 ctoe://」。命令行谁都能伪造，所以门铃不携带句子、令牌和语言，那句话始终
# 走带令牌的 loopback bridge（见 README「浏览器连接」）。

!macro customInstall
  WriteRegStr HKCU "Software\Classes\ctoe" "" "URL:ctoe Protocol"
  WriteRegStr HKCU "Software\Classes\ctoe" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\ctoe\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\ctoe\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\ctoe"
!macroend
