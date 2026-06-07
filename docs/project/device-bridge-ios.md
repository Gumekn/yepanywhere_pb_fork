# Device Bridge：iOS Simulator 支持

## 目标

为 device bridge 增加 iOS simulator streaming，沿用 ChromeOS 和实体 Android 的同一架构：一个小型 native daemon，通过 stdin/stdout 使用共享 binary framing protocol，由 Go sidecar 作为 subprocess 启动。

## 背景

iOS simulator 通过 Apple 私有 `SimulatorKit` framework，把 framebuffer 暴露为共享内存 **IOSurface**。Facebook IDB（`idb_companion`）和 Simulator.app GUI 也使用同一机制。直接访问 IOSurface 比 `xcrun simctl io screenshot` 快几个数量级；后者每帧约 500ms，基本限制在约 2 FPS。

输入注入使用 **IndigoHID** messages。这是 SimulatorKit 内部使用的 Mach message-based protocol。IDB 已 reverse-engineer 相关 structs，并提供 MIT-licensed headers 可参考。

## 架构

和 ChromeOS、Android 一样，采用 subprocess + framing pattern：

```text
Go sidecar ──(stdin/stdout framing)──► ios-sim-server ──(IOSurface + IndigoHID)──► Simulator
```

与现有设备类型对比：

| 设备类型 | Daemon | Transport | Frame source | Input method |
|----------|--------|-----------|--------------|--------------|
| Android emulator | 无，gRPC built-in | gRPC | Emulator gRPC API | Emulator gRPC API |
| Android physical | `yep-device-server.apk` | TCP via `adb forward` | `SurfaceControl.screenshot()` | `InputManager.injectInputEvent()` |
| ChromeOS | `daemon.py` | SSH stdin/stdout | `drm_screenshot_jpeg()` | evdev（`VirtualMouse`、keyboard） |
| **iOS simulator** | **`ios-sim-server`** | **stdin/stdout** | **IOSurface -> VideoToolbox JPEG** | **IndigoHID via SimDeviceLegacyClient** |

## iOS Simulator Daemon（`ios-sim-server`）

一个 Swift command-line tool，约 300 行，用 Swift Package Manager 构建。唯一参数是 simulator UDID。

### Frame capture

1. 为当前 Xcode developer dir 创建 `SimServiceContext`，再用 `initWithSetPath:serviceContext:` 构造 `SimDeviceSet`。
2. 遍历 `deviceSet.devices` 按 UDID 找到 booted `SimDevice`；不要依赖 `bootedDevices`，本地 spike 中它为 `nil`。
3. 从实现 `SimDisplayIOSurfaceRenderable` 的 **port descriptor** 获取 main display IOSurface：优先 `framebufferSurface`，旧 Xcode fallback 到 `.ioSurface`。
4. 通过 `CVPixelBufferCreateWithIOSurface()` 把 IOSurface 包成 `CVPixelBuffer`。
5. 每次收到 0x01 frame request：
   - 可选用 Accelerate framework 的 `vImageScale_ARGB8888` 做缩放，降低带宽。
   - 用 `VideoToolbox` 做 JPEG 编码（`VTCompressionSession` + `kCMVideoCodecType_JPEG`），使用硬件加速。
   - 向 stdout 写入带 JPEG payload 的 0x02 response。

两种 frame mode，对齐 IDB 的思路：

- **Eager（默认）：** 收到 0x01 request 时，重新读取当前 IOSurface pixel buffer 并编码。IOSurface 是共享内存，始终是最新画面。实现简单，不需要注册 callback。
- **Lazy（未来优化）：** 在 display descriptor 上注册 `damageRectanglesCallback`，只有屏幕变化时才编码。静态画面 CPU 更低。

先实现 eager mode。它更简单，也与 Android/ChromeOS 的 pull model 一致。

### Input injection

使用 SimulatorKit 的 IndigoHID 机制：

1. 加载 `SimulatorKit.framework`，并通过 `dlsym` 解析三个 C functions：
   - `IndigoHIDMessageForMouseNSEvent`：touch events
   - `IndigoHIDMessageForKeyboardArbitrary`：key events
   - `IndigoHIDMessageForButton`：hardware buttons，如 home、lock、siri
2. 创建一个用 `SimDevice` 初始化的 `SimDeviceLegacyHIDClient`。
3. 每次收到 0x03 control command：
   - 解析 JSON payload，例如 `{"cmd":"touch",...}` 或 `{"cmd":"key",...}`。
   - 构造对应 `IndigoMessage` struct。
   - 通过 `client.sendWithMessage(_:freeWhenDone:)` 发送。

Touch coordinates 使用 0-1 normalized values，与 Android/ChromeOS 一致。转换到 IndigoHID ratio format：

```text
xRatio = touch.x  (already 0-1, from top-left)
yRatio = touch.y
```

### Handshake

与 Android/ChromeOS 使用相同的 4-byte handshake：

```text
[width uint16 LE][height uint16 LE]
```

屏幕尺寸来自 `SimDisplayDescriptorState.defaultWidthForDisplay` / `defaultHeightForDisplay`，也可以直接从 IOSurface dimensions 读取。

### Wire protocol

与 Android 和 ChromeOS 完全一致，使用共享 binary framing protocol：

```text
Handshake (daemon -> sidecar on connect):
  [width uint16 LE][height uint16 LE]

Frame request (sidecar -> daemon):
  [0x01]

Frame response (daemon -> sidecar):
  [0x02][4-byte LE JPEG length][JPEG bytes]

Control command (sidecar -> daemon, fire-and-forget):
  [0x03][4-byte LE JSON length][JSON bytes]
```

### Private framework headers

从 IDB 的 `PrivateHeaders/` 目录引用（MIT-licensed）。需要最小子集：

| Header | 用途 |
|--------|------|
| `Indigo.h` | `IndigoMessage`、`IndigoTouch`、`IndigoButton` structs |
| `Mach.h` | `IndigoMessage` 的 `MachMessageHeader` |
| `SimDisplayIOSurfaceRenderable-Protocol.h` | 访问 `.framebufferSurface` / `.ioSurface` |
| `SimDisplayRenderable-Protocol.h` | `.displaySize`、damage rect callbacks |
| `SimDisplayDescriptorState-Protocol.h` | `.defaultWidthForDisplay`、`.displayClass` |
| `SimDeviceIOPortInterface-Protocol.h` | 枚举 port，找到 main display |
| `SimDeviceIOProtocol-Protocol.h` | 访问 device IO 上的 `.ioPorts` |
| `SimDeviceLegacyClient.h` | HID input 的 `sendWithMessage:freeWhenDone:` |
| `SimDevice.h` | Device object：`.io`、`.deviceType`、`.UDID` |
| `SimDeviceSet.h` | `defaultSet.devices`，用于按 UDID 查找 |

这些 Objective-C headers 通过 Swift 项目的 bridging header 使用。

### Framework dependencies

构建时链接，均随 Xcode 提供：

| Framework | 用途 |
|-----------|------|
| `CoreSimulator` | `SimDevice`、`SimDeviceSet`，来自 Xcode 的 private framework |
| `SimulatorKit` | `SimDeviceLegacyHIDClient`、IndigoHID functions，来自 Xcode 的 private framework |
| `IOSurface` | 包装 IOSurface object |
| `CoreVideo` | `CVPixelBufferCreateWithIOSurface` |
| `VideoToolbox` | 硬件 JPEG 编码 |
| `Accelerate` | `vImageScale_ARGB8888` 降采样 |
| `CoreGraphics` | `CGPoint`、`CGSize` |

### Build

Swift Package Manager，单 executable target：

```text
packages/ios-sim-server/
├── Package.swift
├── Sources/
│   ├── main.swift              # Entry point, stdin/stdout framing loop
│   ├── Framebuffer.swift       # IOSurface access + JPEG encoding
│   ├── HIDInput.swift          # IndigoHID touch/key/button injection
│   └── BridgeHeaders/          # Obj-C bridging header + private headers
│       ├── bridge.h
│       ├── Indigo.h
│       ├── Mach.h
│       └── ... (subset from IDB PrivateHeaders)
└── Tests/
    └── ... (framing protocol round-trip)
```

构建命令：

```bash
cd packages/ios-sim-server
swift build -c release \
  -Xlinker -F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks \
  -Xlinker -F/Library/Developer/PrivateFrameworks
```

输出：`.build/release/ios-sim-server`

构建出的 binary 还必须包含指向 Xcode/private framework 目录的 runtime `rpath`，否则启动时 dyld 找不到 `SimulatorKit.framework`。

### Distribution

**不能 cross-compile**。这些 private frameworks 只在 macOS/Xcode 上可用，并且和 Xcode 版本绑定。两个方案：

1. **首次使用时构建（推荐）**：选择 iOS simulator device 时，Go sidecar 在 `packages/ios-sim-server/` 中运行 `swift build -c release`，并把 binary 缓存在 device-bridge binary 旁边。类似 Android APK 的 resolve 机制。
2. **CI 预构建 macOS binary**：GitHub Actions macOS runner 构建 binary 并附到 release，像 device-bridge binary 一样按需下载。只有用户 Xcode 版本匹配 CI 时才可靠。

方案 1 更稳，因为 private framework layout 可能在 Xcode 版本之间变化。这个 Swift CLI 很小，构建约 5 秒。

---

## Go Sidecar：`IOSSimulatorDevice`

位于 `packages/device-bridge/internal/device/ios_simulator_device.go`。结构几乎完全对齐 `ChromeOSDevice`：

```go
type IOSSimulatorDevice struct {
    udid    string
    cmd     *exec.Cmd
    reader  io.ReadCloser
    writer  io.WriteCloser
    width   int32
    height  int32
    writeMu sync.Mutex
    // ...
}

func NewIOSSimulatorDevice(ctx context.Context, udid string) (*IOSSimulatorDevice, error) {
    serverPath := resolveIOSSimServer()  // find or build the binary
    cmd := exec.CommandContext(ctx, serverPath, udid)
    cmd.Stdin, _ = cmd.StdinPipe()   // we write to daemon's stdin
    cmd.Stdout, _ = cmd.StdoutPipe() // we read from daemon's stdout
    cmd.Start()
    // read 4-byte handshake for screen dimensions
    // return device ready for GetFrame/SendTouch/SendKey
}
```

### Discovery

Go sidecar 通过以下命令发现 iOS simulators：

```bash
xcrun simctl list devices booted -j
```

该命令返回所有 booted simulators 的 JSON。每个 simulator 在 `DeviceInfo` 中报告为 `type: "ios-simulator"`。

```go
type DeviceInfo struct {
    ID    string  // UDID from simctl
    Label string  // "iPhone 17 Pro (iOS 26.2)"
    Type  string  // "ios-simulator"
    State string  // "booted"
}
```

Client signaling 应在 `device_stream_start` 中传入 `deviceType: "ios-simulator"`，这样 server runtime selection 不需要解析类似 UDID 的 `deviceId`。

### Binary resolution

优先级顺序与 Android APK 类似：

1. `IOS_SIM_SERVER` env var，显式路径。
2. `{data-dir}/bin/ios-sim-server`，预下载 binary。
3. 从源码构建：在 `packages/ios-sim-server/` 中运行 `swift build -c release`。

---

## 实现步骤

### Step 1：Swift daemon skeleton

1. 创建 `packages/ios-sim-server/` 和 `Package.swift`。
2. 从 IDB `PrivateHeaders/` 复制最小 private headers：`Indigo.h`、`Mach.h`、SimDisplay protocols、`SimDevice`、`SimDeviceLegacyClient`。
3. 实现 `main.swift`：
   - 从 argv 解析 UDID。
   - 按 UDID 查找 `SimDevice`。
   - 从 main display 获取 IOSurface。
   - 写出 handshake（width/height）。
   - 进入 read loop：0x01 -> JPEG frame，0x03 -> HID input。
4. 验证：`swift build -c release && echo "test" | .build/release/ios-sim-server <UDID>`。

### Step 2：Frame capture

1. 实现 `Framebuffer.swift`：
   - 用 `CVPixelBufferCreateWithIOSurface` 包装 IOSurface。
   - 使用 VideoToolbox JPEG compression session，启用硬件加速。
   - 可选用 `vImageScale_ARGB8888` 降采样。
2. 验证：手动 capture frames，并与 `simctl screenshot` 的质量/速度对比。

### 本机 spike 发现

已在本机 booted simulator 上验证：

- Booted simulator：`iPhone 17` / `F87D9B80-78AD-4398-B7D4-CA5E74D5474A`
- `xcrun simctl io ... screenshot` baseline：单帧约 `0.52s`
- 通过 private frameworks 访问 `framebufferSurface`：可用
- `SimDeviceLegacyHIDClient initWithDevice:error:`：可用
- `IndigoHIDMessageForMouseNSEvent`、`IndigoHIDMessageForKeyboardArbitrary`、`IndigoHIDMessageForButton`：均可通过 `dlsym` 找到
- One-shot IOSurface -> VideoToolbox JPEG encode：可用
- In-process steady-state capture + JPEG encode benchmark：在基本静态 simulator 屏幕上约 `218-240 FPS`，即每帧约 `4.2-4.6ms`

这些测量说明 simulator capture 不是瓶颈。生产实现应继续复用现有 Go sidecar 处理 WebRTC、adaptive streaming 和 session lifecycle，而不是在 Swift 侧新做一套 streaming stack。

### 推荐生产形态

#### V1

- 保持 `ios-sim-server` 很小，只负责：
  - 按 UDID 处理 simulator discovery
  - IOSurface 访问
  - VideoToolbox JPEG encode
  - IndigoHID input injection
  - stdin/stdout framing
- 通过现有 Go sidecar 集成为 `IOSSimulatorDevice`
- 复用现有 `Device` pull-frame path 和 WebRTC stack

这与当前 ChromeOS subprocess model 一致，也能把平台相关复杂度限制在主 bridge 之外。

#### V2，仅在需要时优化

如果端到端测试显示 JPEG decode/re-encode 成本过高，再把 simulator path 升级为直接 push H.264，并在 Go bridge 中实现 `StreamCapable`。不要一开始就做这个；更简单的 JPEG-framed path 应该先落地。

### Step 3：Input injection

1. 实现 `HIDInput.swift`：
   - 加载 SimulatorKit，通过 `dlsym` 解析 IndigoHID functions。
   - 创建 `SimDeviceLegacyHIDClient`。
   - Touch：用 normalized coordinates 构造 `IndigoMessage`。
   - Key：用 keycode 构造 `IndigoMessage`。
   - Button：home、lock、siri。
2. 验证：发送 touch events，确认 simulator 响应。

### Step 4：Go sidecar integration

1. 增加 `ios_simulator_device.go`：subprocess management + framing protocol。
2. 在 device list 中增加 iOS simulator discovery，解析 `xcrun simctl list devices booted -j`。
3. 在 `DeviceInfo` 中增加 `type: "ios-simulator"`。
4. 接入 `SessionManager` 和 pool。

### Step 5：Tests

- **Go：`IOSSimulatorDevice` with mock subprocess**：使用 `io.Pipe()` fake，模式与 ChromeOS tests 一致。
- **Go：simctl JSON parsing**：为 device list parsing 写单元测试。
- **E2E：iOS simulator streaming**：没有 booted simulator 时 skip，结构与 emulator E2E test 相同。

---

## 性能预期

| 指标 | `simctl screenshot` | `ios-sim-server`（IOSurface） |
|------|---------------------|-------------------------------|
| Frame latency | ~500ms | 本机 spike 中 steady-state encode 约 ~4-5ms |
| Max FPS | ~2 | 本地 encode loop 200+；端到端可能更低 |
| Encoding | N/A，file I/O | VideoToolbox hardware JPEG |
| Scaling | 不支持 | encode 前用 `vImageScale_ARGB8888` |
| Process overhead | 每帧新进程 | 持久进程，共享内存 |

---

## Xcode 版本兼容性

Private frameworks 在不同 Xcode 版本之间会变化。已知差异：

- **IOSurface access**：Xcode 13.2+ 把 `ioSurface` 拆成 `framebufferSurface` + `maskedFramebufferSurface`。Daemon 先尝试 `framebufferSurface`，再 fallback 到 `ioSurface`。
- **HID client class**：`SimDeviceLegacyHIDClient` 从 Xcode 9+ 起较稳定。
- **IndigoHID functions**：从 Xcode 9+ 起较稳定，通过 `dlsym` 动态加载，缺失时可优雅失败。
- **Device set lookup**：本机 spike 中 `+[SimDeviceSet defaultSet]` 不可用；通过 `SimServiceContext` 构造 `SimDeviceSet` 较稳定。
- **Display lookup**：本机 spike 中 `framebufferSurface` 暴露在 display **descriptor proxy** 上，而不是 port object 本身。

在用户机器上从源码构建（distribution 方案 1）可以绕开大多数兼容性问题，因为会链接本机安装的 frameworks。

---

## 非目标

- 实体 iOS device 支持；那需要 `usbmuxd` + developer disk images，是完全不同的技术栈。
- Simulator audio streaming。
- 同时支持多个 simulator display；当前只处理 main display class 0。
- 无 Xcode 运行；private frameworks 要求安装 Xcode。
