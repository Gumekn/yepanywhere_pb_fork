# Yep Anywhere 自用 APK 打包指南

把 yepanywhere 整套打包成一个手机 APK + 一个自建 relay,通过 SRP-6a 鉴权 + NaCl 端到端加密访问 mac 上的服务。所有数据流经的 relay 是你自己的,**没有任何第三方能看到你的代码或会话内容**。

## 架构总览

```
┌─────────────────┐        ┌──────────────────┐        ┌─────────────────┐
│  手机 APK       │  ws    │ frp 公网入口     │ tunnel │  你的 Mac       │
│ (含 React 前端) │ ─────▶ │ gd03.frp0.cc     │ ─────▶ │                 │
│                 │        │ :28101           │        │ Relay :4400     │
│                 │        │                  │        │ ↑               │
│                 │        │                  │        │ │ 出站连接      │
└─────────────────┘        └──────────────────┘        │ ↓               │
                                                       │ yepanywhere     │
                                                       │ :8022           │
                                                       └─────────────────┘
   ── SRP-6a 端到端鉴权(密码不出端)
   ── NaCl XSalsa20-Poly1305 加密(relay 只能转发密文)
```

**关键事实:**
- APK 里**内嵌**了 React 前端(dist-remote 那套),不需要每次启动从网下载
- yepanywhere server 主动**出站**连接 relay,mac 上**不开任何入站端口**(对外可见的只有 frp 那两个公开端口)
- relay 跟 server 用同一个 `username` 配对(`yueyuan`),用 `password` 做 SRP 鉴权
- 改 yepanywhere 服务端代码不用重打 APK;改 React 前端代码要重打 APK

---

## 日常最常用(收藏这一段)

### 1. 启动整套服务(每次开机做一次)

```bash
# Relay (后台,日志在 /tmp/yep-relay.log)
nohup node /Users/yueyuan/Desktop/work/before_work/yepanywhere/packages/relay/dist/index.js \
  > /tmp/yep-relay.log 2>&1 & disown

# yepanywhere 主服务 (LaunchAgent 守护,日志在 ~/.yep-anywhere/logs/server-launchd.*.log)
bash yep.sh start-prod

# 验证两个都起来了
curl -s http://127.0.0.1:4400/health    # 应返回 {"status":"ok",...}
curl -s http://127.0.0.1:8022/api/health 2>&1 | head -1
```

frp 客户端不用单独管,它通常已经在系统启动时自启。

### 2. 看当前状态

```bash
curl -s http://127.0.0.1:4400/status | python3 -m json.tool
# 关注:
#   waiting=1 → yepanywhere 已连 relay 在等手机
#   pairs=1   → 手机已经登录配对成功
#   pairs=0   → 没人在用
```

### 3. 关闭服务

```bash
pkill -f "packages/relay/dist/index.js"
pkill -f "yepanywhere"
```

### 4. 重打 APK(改了前端代码 / 改了 relay URL)

```bash
cd /Users/yueyuan/Desktop/work/before_work/yepanywhere/packages/mobile

# 工具链 PATH(tauri 子进程不一定继承 zshrc,显式 export 最稳)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
export PATH=$HOME/.cargo/bin:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

pnpm tauri android build --debug --apk
# 首次构建 5-10 分钟;有缓存的话 1-3 分钟
```

APK 输出:
```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

### 5. 装到手机

```bash
adb install -r -t \
  /Users/yueyuan/Desktop/work/before_work/yepanywhere/packages/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`-r` 是覆盖装,`-t` 允许 test APK(debug 包必加)。装完手机桌面找 "Yep Anywhere" 图标。

---

## 改 frp 公开 URL

比如 frp 出口端口从 28101 换到别的,或者域名变了。**两处地方要同步改**:

### 1. 客户端硬编(改完要重打 APK)

```ts
// packages/client/src/pages/RelayLoginPage.tsx
const DEFAULT_RELAY_URL = "ws://gd03.frp0.cc:28101/ws";  // ← 改这行

// packages/client/src/components/RemoteAccessSetup.tsx
const DEFAULT_RELAY_URL = "ws://gd03.frp0.cc:28101/ws";  // ← 改这行
```

### 2. mac yepanywhere 服务端的注册信息(改完重启 yepanywhere)

```bash
yepanywhere --setup-remote-access \
  --username yueyuan \
  --password cuijie5622 \
  --relay ws://新地址/ws

# 然后重启 server 让它连新 relay
bash yep.sh restart-prod
```

### 3. frp 配置(在你的 frpc.toml)

```toml
[[proxies]]
name = "yep-relay"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4400              # mac 本地 relay 端口(改这个要同步重启 relay)
remotePort = 28101            # 公网端口(跟 DEFAULT_RELAY_URL 对应)
```

改完 reload frpc。

---

## 改 username / password

### 改 username

```bash
# 先取消注册旧 username(可选,如果还想要 yueyuan 这个名字可以跳)
rm /Users/yueyuan/.yep-anywhere/remote-access.json

# 用新 username 重新注册
yepanywhere --setup-remote-access \
  --username 新名字 \
  --password 旧密码 \
  --relay ws://gd03.frp0.cc:28101/ws

# 重启 yepanywhere
bash yep.sh restart-prod
```

⚠️ **不要随意改 username**:relay 端 SQLite (`~/.yep-relay/relay.db`) 会持久化 username 跟 `installId` 的所有权关系。如果你换 install(比如清空 `~/.yep-anywhere/install.json`),原 username 会被锁住直到 90 天后自动 reclaim。

⚠️ **username 格式**:3-32 字符,只能小写字母 / 数字 / 连字符。

### 改 password

```bash
# 同样的命令,只是密码不一样,会覆盖
yepanywhere --setup-remote-access \
  --username yueyuan \
  --password 新密码 \
  --relay ws://gd03.frp0.cc:28101/ws

bash yep.sh restart-prod

# 然后手机重新登录,填新密码
```

---

## 改 APP 名字 / 图标 / 包名

### 名字
```json
// packages/mobile/src-tauri/tauri.conf.json
"productName": "Yep Anywhere"   // ← 改这里
```

### 图标
```bash
cd packages/mobile
pnpm tauri icon path/to/your-logo.png   # 推荐 1024×1024 PNG
# 自动生成全套尺寸到 src-tauri/icons/ 和 src-tauri/gen/android/.../res/mipmap-*/
```

### 包名 (identifier)
```json
"identifier": "com.yepanywhere.mobile.local"   // ← 改这里
```

⚠️ **必读坑**:identifier 的最后一段不能是 Rust 关键字!
不能用: `self`, `super`, `crate`, `extern`, `Self`, `mod`, `use`, `fn`, `let`, `mut`...
可以用: `local`, `personal`, `byme`, 你的 GitHub 名

改 identifier 后**必须重 init**:
```bash
rm -rf src-tauri/gen/android
pnpm tauri android init
```

---

## 打 Release 包(体积 476MB → ~50MB)

适合长期用、传给家人朋友。需要一次性签名密钥设置,以后每次打包就一行命令。

### 一次性:生成签名密钥

```bash
keytool -genkey -v \
  -keystore ~/yep-anywhere-self.jks \
  -alias yepanywhere \
  -keyalg RSA -keysize 2048 \
  -validity 10000
# 设个简单密码并记住,名字邮箱乱填
```

### 一次性:配置 Gradle 签名

新建 `packages/mobile/src-tauri/gen/android/keystore.properties`:
```properties
password=yourpassword
keyAlias=yepanywhere
storeFile=/Users/yueyuan/yep-anywhere-self.jks
```

⚠️ `storeFile` 必须是绝对路径。

编辑 `packages/mobile/src-tauri/gen/android/app/build.gradle.kts`,在 `android { ... }` 块顶部插入:

```kotlin
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = java.util.Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(java.io.FileInputStream(keystorePropertiesFile))
}
```

在 `android { ... }` 块里加 `signingConfigs`,并把 `buildTypes.release` 改为引用它:

```kotlin
signingConfigs {
    create("release") {
        keyAlias = keystoreProperties["keyAlias"] as String
        keyPassword = keystoreProperties["password"] as String
        storeFile = file(keystoreProperties["storeFile"] as String)
        storePassword = keystoreProperties["password"] as String
    }
}

buildTypes {
    getByName("release") {
        signingConfig = signingConfigs.getByName("release")
        // (已有的 minifyEnabled / proguardFiles 保留)
    }
}
```

⚠️ 把 `keystore.properties` 和 `*.jks` 加 `.gitignore`,千万别提交。

### 每次打包

```bash
cd packages/mobile
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
export PATH=$HOME/.cargo/bin:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

pnpm tauri android build --apk          # 不带 --debug 就是 release
```

输出:
```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

首次 release 编译 5-8 分钟(R8 minify 慢)。

⚠️ Debug → Release 切换装会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`,因为签名不同。先卸载:
```bash
adb uninstall com.yepanywhere.mobile.local
adb install -r release-apk-path
```

---

## 用 monorepo 开发版替换 npm 装的 yepanywhere

目前你用的 `yepanywhere` 命令是 `npm i -g yepanywhere` 装的固定版本(`/Users/yueyuan/.nvm/.../bin/yepanywhere`)。如果你改了 `packages/server/` 的代码,**不会生效**,因为 npm 装的不读 monorepo 源码。

两个选项:

### 选项 A:每次改完代码,重新发包到全局(简单粗暴)

```bash
cd /Users/yueyuan/Desktop/work/before_work/yepanywhere
pnpm build:bundle           # 编译产物到 dist/
pnpm link --global           # 把 monorepo 版本链接为全局命令
# 之后 yepanywhere 命令就是 monorepo 版本
```

要切回 npm 版本:`pnpm unlink --global && npm i -g yepanywhere`

### 选项 B:dev 模式跑(改代码立即生效)

```bash
cd /Users/yueyuan/Desktop/work/before_work/yepanywhere
# 先关闭 npm 装的那个
pkill -f yepanywhere

# 跑 dev 服务(改代码热重载)
pnpm dev
# 默认端口 3400(可 PORT=8022 pnpm dev)
```

⚠️ dev 模式跟现有 `~/.yep-anywhere/` 数据共用(因为同一个 dataDir)。如果你想隔离测试:
```bash
PORT=8022 YEP_ANYWHERE_PROFILE=dev pnpm dev
# 会用 ~/.yep-anywhere-dev/ 完全隔离
```

---

## 关键文件位置

```
packages/
├── client/src/
│   ├── pages/RelayLoginPage.tsx                   # ⭐ DEFAULT_RELAY_URL #1
│   ├── components/RemoteAccessSetup.tsx           # ⭐ DEFAULT_RELAY_URL #2
│   └── ...                                        # 改前端代码后要 pnpm tauri android build
├── server/src/                                    # 改后端代码后要重新发布 / 用 dev 模式
├── relay/
│   ├── dist/                                      # build 产物
│   └── src/                                       # 改 relay 代码后 pnpm build
└── mobile/
    ├── package.json                               # tauri CLI 脚本入口
    ├── SELF-BUILD.md                              # 本文档
    └── src-tauri/
        ├── tauri.conf.json                        # ⭐ identifier / productName / windows
        └── gen/android/                           # ⚠️ tauri android init 生成,在 .gitignore 里
            ├── keystore.properties                # ⚠️ 自加,别 commit
            └── app/build.gradle.kts               # ⭐ 签名配置 / cleartext

数据目录:
~/.yep-anywhere/                                   # yepanywhere 主服务数据
├── remote-access.json                             # ⭐ relay URL + SRP credentials
├── install.json                                   # installId(决定 relay 上 username 所有权)
└── ...

~/.yep-relay/                                      # relay 服务数据
├── relay.db                                       # ⭐ username 注册表(SQLite)
└── logs/relay.log

~/yep-anywhere-self.jks                            # ⚠️ release 签名密钥,丢了就没法升级 APP
```

---

## 工具链信息

| 组件 | 版本 | 路径 |
|------|------|------|
| JDK | OpenJDK 17.0.19 | `/opt/homebrew/opt/openjdk@17` |
| Rust | 1.95.0 | `~/.cargo/bin` |
| Android SDK | API 36 (Android 16) | `$ANDROID_HOME/platforms` |
| Build Tools | 36.0.0 | `$ANDROID_HOME/build-tools` |
| Android NDK | 28.2.13676358 | `$ANDROID_HOME/ndk/...` |
| Tauri CLI | 2.10.1 | `packages/mobile/node_modules` |
| ADB | 1.0.41 | `/opt/homebrew/bin/adb` |

### `~/.zshrc` 里加的环境变量

```bash
# === Yep Anywhere Android build toolchain ===
export JAVA_HOME=$(brew --prefix openjdk@17)
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
export PATH="$HOME/.cargo/bin:$PATH"
```

### 全新机器从零安装

```bash
# 1. JDK 17
brew install openjdk@17

# 2. Rust + Android targets
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# 3. Android SDK(可能已经有了)
brew install --cask android-commandlinetools android-platform-tools
yes | sdkmanager --licenses
sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;28.2.13676358"

# 4. 写 ~/.zshrc 加上面那段环境变量

# 5. 装 mobile + relay 依赖
cd /path/to/yepanywhere
pnpm install --filter @yep-anywhere/mobile --filter @yep-anywhere/relay --filter @yep-anywhere/shared

# 6. 编译 relay
pnpm --filter @yep-anywhere/shared build
pnpm --filter @yep-anywhere/relay build

# 7. 装 yepanywhere 服务
npm i -g yepanywhere

# 8. 注册到自己的 relay(先确保 relay 已经在 mac 上 nohup 跑起来)
yepanywhere --setup-remote-access \
  --username yueyuan \
  --password cuijie5622 \
  --relay ws://gd03.frp0.cc:28101/ws

# 9. 启动 yepanywhere 主服务
bash yep.sh start-prod

# 10. 在 mobile 包里打 APK + 装手机
cd packages/mobile && pnpm tauri android build --debug --apk
adb install -r -t src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

---

## 故障排查

### 手机登录显示"找不到服务器" / "用户名未注册"

`yepanywhere` 没在跑,或者没连上 relay。验证:
```bash
ps aux | grep yepanywhere | grep -v grep    # 应该有 1 个进程
curl -s http://127.0.0.1:4400/status | python3 -m json.tool
# waiting >= 1 才说明 server 连上了 relay
```

如果 waiting=0,看 server 日志:
```bash
tail -20 ~/.yep-anywhere/logs/server-launchd.err.log | grep -iE "relay|error"
# 常见原因:remote-access.json 不存在 / relay 离线 / frp 没通
```

### 手机登录显示"密码错误"

`~/.yep-anywhere/remote-access.json` 里存的 SRP credentials 是用某个密码生成的。重新 setup 一遍并确认:
```bash
yepanywhere --setup-remote-access --username yueyuan --password 正确的密码 \
  --relay ws://gd03.frp0.cc:28101/ws
bash yep.sh restart-prod
```

### `pairs=1` 但手机一直转圈不进列表

通常是 yepanywhere server 后端 API 响应慢 / 失败。看:
```bash
tail -30 ~/.yep-anywhere/logs/server-launchd.err.log | grep -iE "error|warn"
```

### `tauri android init` 报错 `expected identifier, found keyword 'self'`
identifier 最后一段是 Rust 关键字。改 `tauri.conf.json` 的 `identifier`,然后:
```bash
rm -rf src-tauri/gen/android && pnpm tauri android init
```

### `failed to run 'cargo metadata'`
Tauri 找不到 cargo。打包前显式 `export PATH=$HOME/.cargo/bin:$PATH`。

### `Unable to locate a Java Runtime` / `JAVA_HOME not set`
显式 `export JAVA_HOME=/opt/homebrew/opt/openjdk@17`。

### `adb devices` 看不到设备
- 手机屏幕看是否有"允许此电脑调试"对话框,点"始终允许"
- USB 必须是"文件传输 / MTP",不是"仅充电"
- `adb kill-server && adb start-server && adb devices`
- 换条数据线(很多 USB-C 线只能充电)

### Release APK 装不上,`INSTALL_FAILED_UPDATE_INCOMPATIBLE`
debug → release 切换,签名不同。先 `adb uninstall com.yepanywhere.mobile.local`。

### Frp 通不了
```bash
# mac 上 relay 在监听吗
lsof -iTCP:4400 -sTCP:LISTEN

# 公网走 frp 通吗(从 mac 自己)
curl -m 5 http://gd03.frp0.cc:28101/health

# frpc 状态(看你的 frpc 启动方式)
ps aux | grep frpc | grep -v grep
```

### Username 被锁(`username_taken` 错误)
relay 的 SQLite 持久化了 `username → installId` 的所有权。如果你换了 install(比如清空了 `~/.yep-anywhere/install.json`),原 username 锁 90 天。临时绕过:
```bash
# 暴力清空 relay 数据(注意会影响所有注册过的 username)
pkill -f packages/relay/dist/index.js
rm ~/.yep-relay/relay.db
nohup node /Users/yueyuan/Desktop/work/before_work/yepanywhere/packages/relay/dist/index.js \
  > /tmp/yep-relay.log 2>&1 & disown
# 然后重新 setup
```

---

## 一些隐含约定

1. **`src-tauri/gen/android/` 不进 git**,每次 `tauri android init` 重新生成。所以重要修改(如签名配置)要记在这份文档里,不要只改 gen 目录的文件——`init` 一次就丢。

2. **`tauri.conf.json` 是真理之源**:identifier、版本、APP 名都从这里读。改了它再 build 才能生效。

3. **改 frontend 要重打 APK**:`packages/client/src/` 的任何改动(包括 `DEFAULT_RELAY_URL`)都需要重打 APK,因为前端是 build 时打包进 APK 的。

4. **改 server 不用重打 APK**:改 `packages/server/src/` 重启 yepanywhere 服务就够了,APP 端无感。

5. **改 relay 自身代码**:`pnpm --filter @yep-anywhere/relay build` + 重启 relay 进程。

6. **`installId` 是身份**:`~/.yep-anywhere/install.json` 里的 UUID 是这台 mac 在 relay 上的"身份证"。删了它再启动会生成新 UUID,relay 会认为这是个新机器,可能拒绝 username。**删之前先 reclaim 旧 username**(见故障排查)。
