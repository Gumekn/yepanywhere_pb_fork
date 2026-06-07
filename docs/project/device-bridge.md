# Device Bridge：把远程控制扩展到模拟器之外

## 目标

Android 模拟器远程控制已经完成到 Phase 3；详见 [android-emulator-remote-control.md](android-emulator-remote-control.md)。它可以通过 WebRTC 把正在运行的 Android emulator 串流到任意浏览器，并通过 DataChannel 发送触控和按键输入。Sidecar binary（`emulator-bridge`）负责编码和 WebRTC，Yep server 管理它的生命周期。

本文说明如何沿用同一架构，继续支持 **USB 连接的实体 Android 设备**，以及作为个人/内部工具的 **通过 SSH 控制 ChromeOS 设备**。现有 emulator 路径保持不变；这是扩展系统，而不是替换系统。

## 已有能力

Emulator pipeline 已完整跑通：

```text
Phone ──(relay)──► Yep Server ──(WS IPC)──► Go sidecar ──(gRPC)──► Android Emulator
                                                  │
                                        WebRTC P2P (H.264 video + DataChannel input)
                                                  │
                                               Phone
```

`packages/emulator-bridge/` 中的关键组件：

- **`internal/emulator/`**：封装 Android Emulator screenshot/input API 的 gRPC client；`FrameSource` 使用 pub/sub，并在没有 subscriber 时自动暂停。
- **`internal/encoder/`**：RGB888 -> I420 转换，以及 x264 H.264 编码（ultrafast/zerolatency）。
- **`internal/stream/`**：Pion WebRTC peer、trickle ICE、DataChannel input handler。
- **`internal/ipc/`**：session lifecycle、ref-counted resource pool、ADB discovery。
- **`packages/server/src/emulator/`**：TypeScript service，管理 sidecar process 和 IPC。

`emulator/` package 之上的部分（encoding、WebRTC、session pool）已经基本与设备类型无关。真正与设备绑定的是 emulator gRPC client。

## 需要改变什么

### 命名

当前 package 和外部名称都写着 `emulator`，但目标已经扩展为任意 testbed device。新增设备类型前先做一次重命名。

| 当前 | 新名称 |
|------|--------|
| `packages/emulator-bridge/` | `packages/device-bridge/` |
| `EmulatorBridgeService` | `DeviceBridgeService` |
| `emulator_stream_start` / `emulator_webrtc_offer` / ... | `device_stream_start` / `device_webrtc_offer` / ... |
| `/api/emulators` | `/api/devices` |
| `EmulatorInfo`, `EmulatorStreamStart`, ... | `DeviceInfo`, `DeviceStreamStart`, ... |
| `capabilities.emulator` | `capabilities.deviceBridge` |
| Go IPC messages `session.start.emulatorId` | `session.start.deviceId` |

Go 内部 package 名称如 `internal/emulator/`、`internal/encoder/` 可暂时保留；它们是实现细节。

### Device abstraction

当前 session pipeline 直接依赖 `*emulator.Client`。抽出 `Device` interface 后，`emulator.Client`、`AndroidDevice`、`ChromeOSDevice` 都能接入同一套 session/pool machinery。

```go
type Device interface {
    GetFrame(ctx context.Context, maxWidth int) (*Frame, error)
    SendTouch(ctx context.Context, touches []TouchPoint) error
    SendKey(ctx context.Context, key string) error
    ScreenSize() (width, height int32)
    Close() error
}
```

`emulator.Client` 已经具备这些方法。这里不改变行为，只是把接口正式化。

`DeviceInfo` 增加 `type`：

```go
type DeviceInfo struct {
    ID    string            // "emulator-5554", ADB serial, or hostname
    Label string            // "Pixel 7 (emulator)", "Pixel 8 Pro", "Chromebook"
    Type  string            // "emulator" | "android" | "chromeos"
    State string            // "running" | "stopped" | "connected"
}
```

Client canonical schema（`packages/shared/src/devices.ts`）：

```ts
type DeviceType = "emulator" | "android" | "chromeos" | "ios-simulator";
type DeviceState = "running" | "stopped" | "connected" | "disconnected" | "booted";

interface DeviceInfo {
  id: string;
  label: string;
  type: DeviceType;
  state: DeviceState;
  actions?: ("stream" | "screenshot" | "start" | "stop")[];
  avd?: string; // legacy compatibility
}
```

`device_stream_start` 应在 client 已知时带上 `deviceType`，避免 server 依赖 ID heuristic 判断运行时类型。

### Frame capture model：所有设备都使用 pull

Emulator 当前就是 pull 模式，由 sidecar 轮询 gRPC。实体 Android 和 ChromeOS 也使用 pull，因为不 root 的情况下没有公开的 “frame ready” 通知。`FrameSource` polling loop 对所有设备类型都能复用，新增点只有 `Device.GetFrame()`。

---

## 新设备类型

### 实体 Android（主要目标）

通过 USB 连接的 Android 设备。不需要 root。使用 scrcpy 发现的 `app_process` 技巧：以 `shell` 用户运行 `adb shell app_process`，即可通过 reflection 调用 `SurfaceControl.screenshot()` 和 `InputManager.injectInputEvent()`。

**设备端：APK server**

一个最小 APK（`yep-device-server.apk`），无 UI、无 manifest permissions、无安装弹窗。由 sidecar 启动：

```bash
adb -s <serial> push yep-device-server.apk /data/local/tmp/
adb -s <serial> shell CLASSPATH=/data/local/tmp/yep-device-server.apk \
    app_process /system/bin com.yepanywhere.DeviceServer
adb -s <serial> forward tcp:27183 tcp:27183   # video
adb -s <serial> forward tcp:27184 tcp:27184   # control
```

APK 监听 TCP 端口，不连接互联网，也不申请权限。

**Wire protocol（单连接）**

使用一个 `adb forward` 和一个端口（27183）。一个小型 message framing protocol 同时承载 video 和 control：

```text
Handshake (device -> sidecar on connect):
  [width uint16 LE][height uint16 LE]

Frame request (sidecar -> device):
  [0x01]

Frame response (device -> sidecar):
  [0x02][4-byte LE JPEG length][JPEG bytes]

Control command (sidecar -> device, fire-and-forget, no response):
  [0x03][4-byte LE JSON length][JSON bytes]
  e.g. {"cmd":"touch","touches":[{"x":0.5,"y":0.3,"pressure":1.0}]}
       {"cmd":"key","key":"back"}
       {"cmd":"capture_settings","maxWidth":360}
```

Touch、key、capture-settings 都是 fire-and-forget，不需要 ack。`capture_settings.maxWidth` 允许设备端在 JPEG 编码前先降采样，降低实体设备上的采集/编码开销。设备端使用 reader goroutine 处理 0x01 frame request 和 0x03 command，writer goroutine 发送 0x02 frame。Sidecar 的 video/input goroutine 共享同一连接，并用 write mutex 串行写入。

使用 JPEG 是因为 `Bitmap.compress(JPEG, 70, stream)` 是 Android 内置能力，而且 sidecar 最终也要解码到 YUV 再交给 x264；相比 raw RGB888，JPEG 通过 ADB tunnel 传输小得多。

**Go sidecar：`AndroidDevice`**

实现 `Device`。Sidecar 先做 `adb forward`，然后连接 `localhost:27183/27184`，读取 handshake 得到屏幕尺寸，并通过连接分发 `GetFrame()` / `SendTouch()` / `SendKey()`。

**Discovery**

`adb devices` 会列出实体设备和 emulators。Discovery 同时报告两者：实体设备 `type: "android"`，emulators 保持 `type: "emulator"`。选择实体设备时，sidecar 自动处理 APK push 和 `adb forward`。

**APK distribution**

CI 构建 `yep-device-server.apk`，并和 sidecar binary 一起附到 GitHub release。Yep server 首次使用时自动下载到 `~/.yep-anywhere/bin/yep-device-server.apk`，复用 sidecar binary 的下载机制。

---

### ChromeOS（个人/内部）

面向开启 developer mode 且可通过 SSH root 访问的 Chromebook（`~/.ssh/config` 里配置 `chromeroot`）。这不是开箱即用能力；用户需要手工准备 SSH tunnel。UI 不做自动发现，也不自动部署。

**设备端：`daemon.py`**（位于私有 repo `chromeos-testbed`）

这是一个围绕现有 `client.py` 逻辑的轻量 stdin/stdout binary-framing wrapper。不开放 TCP 端口，包括 localhost-only 也不开放。输入和截图 primitives 已存在：`drm_screenshot` via EGL/GBM、`VirtualMouse`、evdev touch/keyboard。Daemon 增加：

- 通过 stdin/stdout 做 binary framing，协议与 Android 相同。
- Frame loop 调用 `drm_screenshot_jpeg()`，按 target FPS 响应 0x01 request。
- 0x03 control commands 转发给现有 `client.py` handlers。

手工部署：

```bash
scp ~/code/chromeos-testbed/daemon.py chromeroot:/mnt/stateful_partition/c2/
```

**Go sidecar：`ChromeOSDevice`**

位于本 repo 的 `packages/device-bridge/internal/device/`。它启动 `ssh chromeroot python3 /mnt/stateful_partition/c2/daemon.py` 作为 subprocess，并把 SSH process 的 stdin/stdout 作为连接。协议与 Android 相同，只是 transport 从 TCP socket 换成 pipes。Chromebook 上没有监听服务；SSH session 本身就是 transport。Sidecar 直接管理 SSH process 生命周期。

```go
cmd := exec.Command("ssh", "chromeroot",
    "python3 /mnt/stateful_partition/c2/daemon.py")
// talk the same frame/control protocol over cmd.Stdin + cmd.Stdout
```

`tap`、`mouse_move`、`key` control commands 直接映射到现有 `client.py` handlers。`chromeroot` 从 `CHROMEOS_HOST` env var 读取，默认值为 `chromeroot`。

---

## 实现阶段

### Phase 0：Baseline tests（改代码前先补）

E2E test 先为完整 streaming stack 建立绿色基线。下面两个 unit-level tests 补齐底层缺口。

**已完成：**

- ✅ E2E：`packages/client/e2e/emulator-stream.spec.ts`，覆盖 full stack regression（sidecar -> WebRTC -> browser video）

**仍需要：**

1. **Go：binary framing protocol round-trip**（`packages/emulator-bridge/internal/conn/framing_test.go`）

   Framing layer 是所有 device type 共享的 wire protocol：`[0x01]` frame request、`[0x02][4-byte len][JPEG]` frame response、`[0x03][4-byte len][JSON]` control。这里的 bug 会静默破坏所有设备类型。新增任何设备类型前，先用 `io.Pipe()` 做隔离测试：

   ```go
   func TestFramingRoundTrip(t *testing.T) {
       server, client := io.Pipe() // fake device ↔ sidecar connection

       // fake device side: respond to frame request with test JPEG
       go func() {
           // read 0x01 frame request
           // write 0x02 + length + bytes
       }()

       // sidecar side: send request, read response
       // assert bytes match
   }
   ```

   先写在 `emulator-bridge` 中；Phase 1 rename 时一起移到 `device-bridge`。

2. **TypeScript：WebSocket message router dispatch**（`packages/server/src/routes/ws-message-router.test.ts`）

   `ws-message-router.ts` 会把 `emulator_stream_start`、`emulator_webrtc_answer`、`emulator_ice_candidate`、`emulator_stream_stop` 分发给 `EmulatorBridgeService`。这块目前没有测试，而 Phase 1 rename 正好会改它。用 mock service 做一个简单 unit test，确认 routing table 正确：

   ```typescript
   it("routes emulator_stream_start to bridgeService.startStream()", async () => {
     const mockBridgeService = { startStream: vi.fn() }
     // dispatch message -> assert mockBridgeService.startStream was called
   })
   ```

**完成条件：** `pnpm test` 和 E2E test 都通过。

---

### Phase 1：Rename（机械改名，不改行为）

1. `packages/emulator-bridge/` -> `packages/device-bridge/`，包括目录和 build files。
2. `EmulatorBridgeService` -> `DeviceBridgeService`；`packages/shared/src/emulator.ts` 中的 TS types -> `devices.ts`。
3. WebSocket message types：`emulator_stream_*` -> `device_stream_*`。
4. REST routes：`/api/emulators` -> `/api/devices`。
5. 更新所有 imports、references 和 client UI。

UI 中 emulator tab 继续叫 “Emulators” 还是改为 “Devices” 是单独的 UX 决策。

**输出：** 行为完全一致，但命名清晰。

**完成条件：** `pnpm typecheck && pnpm lint && pnpm test` 全部通过，然后跑 E2E test；E2E 是 rename 的主要安全网。

---

### Phase 2：Device interface + ChromeOS daemon

先做 ChromeOS：`client.py` 已经具备 primitives，SSH subprocess 方式无需部署流程，而且 Chromebook 通常常开。

1. 在 `packages/device-bridge/internal/device/device.go` 增加 `Device` interface；让 `emulator.Client` 实现它（`FrameSource` + `SessionManager` 做最小 wiring change）。
2. 在私有 **`chromeos-testbed` repo** 中写 `daemon.py`：stdin/stdout binary framing、`drm_screenshot_jpeg` frame capture、复用 `client.py` control handlers。
3. 在 `packages/device-bridge/internal/device/` 中写 `ChromeOSDevice.go`：启动 `ssh $CHROMEOS_HOST python3 daemon.py`，并在 SSH stdin/stdout 上使用共享 framing protocol。
4. 将 `ChromeOSDevice` 接入 `SessionManager` 和 pool；`DeviceInfo` 增加 `type: "chromeos"`。
5. 只支持手工配置：`CHROMEOS_HOST` env var，默认 `chromeroot`；不做 auto-discovery。

**Phase 2 新测试：**

- **Go：`ChromeOSDevice` framing with mock subprocess**：用 `io.Pipe()` 假装 SSH stdin/stdout，发送 handshake、frame request、control command，确认 device side 能处理。
- **Go：`FrameSource` works with `Device` interface**：用 mock `Device` 验证 `FrameSource` 会调用 `GetFrame()`，并把结果分发给 subscribers，确认 interface wiring 没破坏 emulator path。

**完成条件：** `packages/device-bridge` 中 `go test ./...` 通过；然后跑 E2E，确认 emulator path 仍正常。

---

### Phase 3：实体 Android 设备

所有代码都在本 repo 内。

1. 增加 `packages/android-device-server/`：Android APK source，包含 `app_process` entrypoint、`SurfaceControl` screenshot loop、`InputManager` injection、27183 单 TCP listener。
2. 在 `packages/device-bridge/internal/device/` 写 `AndroidDevice.go`：ADB-forwarded connection 的 TCP client，使用同一 framing protocol。
3. 将 `AndroidDevice` 接入 `SessionManager` 和 pool；扩展 `adb devices` discovery，同时输出实体设备和 emulator。
4. 选择实体设备时，sidecar 自动完成 APK push 和 `adb forward`。
5. CI 构建 APK，并和 sidecar binary 一起作为 release artifact。

**Phase 3 progress（2026-03-02）：**

- ✅ `bridge-ci.yml` 已构建/发布 `device-bridge-*` binaries 和 `yep-device-server.apk`
- ✅ Server download endpoint 已拉取两类 artifacts：`POST /api/devices/bridge/download`
- ✅ `DeviceBridgeService.startStream()` 对 Android/APK transport session 自动确保 APK 可用

**Android APK streaming 性能发现（2026-03-02，Pixel 7a / Android 16）：**

- 直接 APK protocol benchmark（通过 `adb forward` 到 `:27183`，循环 `0x01` frame request）：
  - 60 measured frames（warmup 后）：**2.36 fps**
  - Frame request round-trip latency：**~424 ms avg**（p50 ~413 ms，p95 ~493 ms）
  - JPEG payload size：当前 `JPEG_QUALITY=70` 下 **~164 KB avg**
- 设备端 raw capture micro-benchmark：
  - 重复 `adb shell 'screencap -p >/dev/null'`：**~341 ms avg**（~2.93 fps ceiling）
  - 重复 `adb exec-out screencap -p`：**~369 ms avg**（~2.71 fps ceiling）
- Host-side bridge processing 对单帧 `1080x2400 -> 360x800` 不是主瓶颈：
  - JPEG decode + RGB expand + scale/I420 + x264 encode：local bench **~41 ms avg**（约 24 fps headroom）

**当前瓶颈总结：**

1. **主瓶颈**：`DeviceServer.java` 的 APK capture path 每帧都启动新的 `screencap -p` subprocess，然后 PNG decode + JPEG re-encode（`captureFrame()` + `runCommand()`），实体设备上吞吐被限制到低个位数 fps。
2. **次瓶颈**：`AndroidDevice.GetFrame()` 当前忽略 `maxWidth`，总是处理全分辨率帧；本次测试为 `1080x2400`，增加了采集和转换工作。
3. **第三瓶颈**：Go `decodeJPEGToRGB()` 使用逐像素 `img.At()` 转换，功能正确但高分辨率下不够高效。

**结论：** 完整 WebRTC session 中观测到的约 1 fps，与 source stage 在进入网络/peer overhead 前就只有约 2-3 fps 的现状一致。

**Phase 3 新测试：**

- **Go：`AndroidDevice` with mock TCP server**：测试中启动 `net.Listen` TCP server，让 `AndroidDevice` 连接它。发送 handshake + frame response，断言 `GetFrame()` 返回正确 bytes。
- **Go：ADB device-list parsing**：用包含 emulator serial 和实体 serial（如 `R3CN90ABCDE`）的 `adb devices` 输出做单元测试，确认正确分类为 `type: "emulator"` 或 `type: "android"`。
- **E2E：physical device variant**：如果没有实体设备则 skip；结构与 `emulator-stream.spec.ts` 相同，但检查 `adb devices` 中是否有非 emulator serial。

**完成条件：** `go test ./...` 通过；emulator E2E 仍通过；如果连接了实体设备，physical device E2E 也通过。

---

### Phase 4：iOS simulator

完整设计见 [device-bridge-ios.md](device-bridge-ios.md)。

通过一个 Swift CLI（`ios-sim-server`）访问 simulator framebuffer：使用 IOSurface（私有 `SimulatorKit` framework）采集画面，并通过 IndigoHID 注入 touch/key input。它使用和 ChromeOS `daemon.py` 相同的 stdin/stdout binary framing protocol。Go sidecar 像管理 `ChromeOSDevice` 一样把它作为 subprocess 启动。

1. 增加 `packages/ios-sim-server/`：Swift Package Manager CLI，使用私有 CoreSimulator/SimulatorKit frameworks 做 IOSurface frame capture + IndigoHID input injection。
2. 在 `packages/device-bridge/internal/device/` 写 `IOSSimulatorDevice.go`：管理 subprocess + stdin/stdout framing，结构对齐 `ChromeOSDevice`。
3. 通过 `xcrun simctl list devices booted -j` 做 iOS simulator discovery；在 `DeviceInfo` 中报告 `type: "ios-simulator"`。
4. 首次使用时从源码构建 binary（`swift build -c release`），因为私有 frameworks 与 Xcode 版本相关。

**Phase 4 新测试：**

- **Go：`IOSSimulatorDevice` with mock subprocess**：用 `io.Pipe()` fake stdin/stdout，模式与 ChromeOS device tests 相同。
- **Go：simctl device-list JSON parsing**：为 booted simulator discovery 写单元测试。
- **E2E：iOS simulator streaming**：没有 booted simulator 时 skip；结构与 `emulator-stream.spec.ts` 相同。

**完成条件：** `go test ./...` 通过；所有之前的 E2E tests 仍通过；如果有 booted simulator，iOS simulator E2E 通过。

---

## Regression Test：Emulator Streaming E2E

每个阶段结束后，以及任何显著改动 sidecar、server emulator routes、WebSocket message handling 或 client streaming code 后，都要跑这个测试。它是唯一覆盖完整链路的 end-to-end 测试。

### 测试内容

`packages/client/e2e/emulator-stream.spec.ts` 会用真实 Playwright browser 跑完整 streaming flow：

1. 导航到 `/emulator?auto`
2. 等待 WebRTC connection state 到 `"connected"`（30 秒 timeout）
3. 确认 `<video>` element 可见
4. 确认 video 至少收到一帧（`readyState >= HAVE_CURRENT_DATA`）

只要链路中任一环坏了，例如 sidecar startup、IPC message routing、SDP/ICE signaling、H.264 encoding、client-side connection state tracking，这个测试都会失败。

### 前置条件

两项都满足才会运行，否则测试会 **自动 skip**，因此 CI 中是安全的。

1. **Bridge binary 已构建：**

   ```bash
   cd packages/emulator-bridge
   go build -o bridge ./cmd/bridge/
   ```

2. **已有运行中的 Android emulator**，通过 `adb devices` 检查：

   ```bash
   source ~/.profile && adb devices   # should show "emulator-5554  device"
   # if not running:
   emulator -avd <avd-name> -no-window &
   ```

   可用 AVD 名称：`emulator -list-avds`

### 运行测试

```bash
pnpm test:e2e --grep "streams emulator"
```

正常输出：

```text
✓  e2e/emulator-stream.spec.ts › streams emulator video over WebRTC when ?auto is set (2.0s)
1 passed
```

缺少前置条件时的预期输出，例如 CI：

```text
-  e2e/emulator-stream.spec.ts › streams emulator video over WebRTC when ?auto is set
1 skipped
```

### 已知环境要求

Test server 必须运行在普通 HTTP 上。如果 shell 中设置了 `HTTPS_SELF_SIGNED=true`，`global-setup.ts` 会为 test server 显式清除它，不需要手动 unset。

---

## Android Agent Control（Accessibility Tree + CLI）

完整设计见 [device-bridge-android-a11y.md](device-bridge-android-a11y.md)。

这部分扩展 `DeviceServer.java`，增加 `UiAutomation` accessibility tree 支持，让 AI agents 不依赖截图也能理解并操作 Android 屏幕。独立 CLI（`bin/android-agent`）通过 ADB forwarding 直接和 APK 通信，独立于 streaming bridge。它参考 [chromeos-testbed](~/code/chromeos-testbed) 的模式：`snapshot` -> `find` -> `tap`/`type` -> `snapshot`，输出紧凑、适合 LLM 使用，并提供 skill definition 供 agent 集成。

---

## Real-Device Hardware Encoding（MediaCodec）

完整设计见 [device-bridge-mediacodec.md](device-bridge-mediacodec.md)。

当前实体设备 capture path 是逐帧轮询 screenshot API，在 Pixel 7a 上约 400ms/frame，也就是约 2.5 fps。MediaCodec 方案会替换为连续的 `SurfaceControl.createDisplay()` -> `VirtualDisplay` -> `MediaCodec` hardware H.264 pipeline。硬件编码器直接输出 NAL units，Go sidecar 直接转发到 WebRTC，不再走 JPEG encode/decode、RGB -> I420 转换和 x264 software encoding hot path。预期：30-60 fps，<50ms latency。

Emulator path（gRPC screenshots -> x264）保持不变。

---

## 非目标

- ChromeOS auto-discovery 或 auto-deploy；当前只手工配置。
- 无 USB 的 WiFi Android；v2 再考虑，ADB wireless pairing 会增加复杂度。
- Audio streaming。
- 通用 remote desktop；这是开发/监督工具。
- Android mouse scroll；大多数 Android app 会忽略 hover/scroll events。
