<p align="center">
  <img src="https://github.com/FlyKite/Wepo/blob/main/images/icon-72@2x.png?raw=true" width="72" height="72" alt="Wepo 微仓">
</p>
<h1 align="center">Wepo 微仓</h1>

你的微信，是不是也占了手机一大半空间？聊天记录舍不得删，手机又天天提示存储不足。

微仓（Wepo）就是为这个场景做的：把没加密的 iPhone 备份里的微信记录解析出来，放到自己搭的服务端。手机上的空间可以腾出来，想翻旧聊天的时候打开网页就能看，界面跟微信电脑版差不多。

导入交给桌面客户端「微仓助手」，存储和查询交给服务端。文字、图片、语音、视频、文件、链接、引用、表情都能看；多个账号、多份备份可以合并去重，也支持全局搜索和手机、平板浏览。

只建议用来查看自己的备份数据。请遵守当地法律法规，保管好备份文件和服务端 Secret。

## 安装

### 在 NAS 上安装

在 NAS 的 Docker 或容器应用里搜 `flykite/wepo`，下载镜像，建个容器。

记得把容器的 `3800` 端口映射出来；`/data` 挂一个固定目录存数据；iPhone 备份放在哪，就把那个目录只读挂到 `/backups`。Secret 不填也行，第一次启动会自动生成，去容器日志或者 `/data/config.json` 里抄下来。

![在 NAS 上搜索 flykite/wepo](https://github.com/FlyKite/Wepo/blob/main/images/nas-docker.png?raw=true)

### 在本机安装

先装 Node.js 18（推荐 18.19.1），然后：

```bash
git clone https://github.com/FlyKite/Wepo.git
cd Wepo
npm install
npm --prefix packages/server install
npm run server
```

打开 `http://127.0.0.1:3800` 就能用。

想导入电脑上的备份，或者用桌面客户端，再开一个终端跑 `npm run desktop:dev`。要打包成 App 就跑 `npm run desktop:package`，不过得装好 Rust 和 Xcode Command Line Tools（macOS）；打出来的包没签名，第一次打开要去系统设置里放行。

## 使用方式

### 备份 iOS 与导入数据

1. 用 Finder（Windows 上是 iTunes 或 Apple Devices）给 iPhone 做一次本地备份。别勾“加密本地备份”，勾了微仓就读不了。macOS 的备份默认在 `~/Library/Application Support/MobileSync/Backup`；Windows 可以在备份列表里右键查看位置。
2. 把整个备份文件夹丢进 NAS 上映射给 `/backups` 的目录，确认里面有 `Manifest.plist` 和 `Manifest.db`。
3. 浏览器打开服务端，进「我 → 数据源」，选中这份备份，点「导入」。不想折腾 NAS 的话，也可以打开微仓助手，直接选本机的备份文件夹或 zip 包。

导入时会显示进度，中途断了可以接着导，已经导过的备份不会重复导入。

注意：新版微信如果单独开了聊天记录加密，数据库是读不出来的，这种备份目前没法解析。

![给 iPhone 做本地备份](https://github.com/FlyKite/Wepo/blob/main/images/ios-backup.png?raw=true)
![在数据源中导入备份](https://github.com/FlyKite/Wepo/blob/main/images/import.png?raw=true)

### 查看数据

打开 `http://<服务器地址>:3800`，输入 Secret，聊天列表就出来了。

电脑、手机、平板都能用。手机浏览器可以“添加到主屏幕”，用起来跟 App 差不多。在「我」页面能切账号，也能换深色/浅色外观。

同一个账号导入多份备份时，联系人和消息会自动合并去重。备份里缺的图片、语音会显示占位，不影响看文字。

最后提醒一句：别把服务端直接开到公网。真要外网访问，至少把 HTTPS 和足够强的 Secret 配好。

![查看聊天记录](https://github.com/FlyKite/Wepo/blob/main/images/viewer.png?raw=true)

## 鸣谢

本项目的实现参考了 [BlueMatthew/WechatExporter](https://github.com/BlueMatthew/WechatExporter) 以及 [DreamHunter2333](https://github.com/DreamHunter2333/) 的私有仓库，在此感谢作者。
