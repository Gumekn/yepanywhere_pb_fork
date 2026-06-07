# Android 实体设备串流：MediaCodec 硬件编码

## 问题

当前实体设备 capture pipeline 是逐帧轮询 screenshot APIs。在 Pixel 7a（Android 16）上，每次 `ScreenCapture.capture()` 或 `SurfaceControl.captureDisplay()` 约 400ms，任何 streaming overhead 之前就已经被限制在约 2.5 fps。瓶颈在设备端 capture，不在 WebRTC 或 x264。

当前 pipeline（逐帧）：

```text
Screenshot API call (~400ms)
  -> Hardware bitmap -> software copy
  -> Optional downscale
  -> JPEG encode (Bitmap.compress)
  -> TCP send to Go sidecar
  -> JPEG decode -> RGB -> I420 -> x264 encode
  -> WebRTC RTP
```

## 方案：连续 VirtualDisplay -> 硬件 H.264

用持久 VirtualDisplay 替换逐帧 screenshot polling，把实体屏幕镜像到硬件 MediaCodec encoder。Encoder 连续输出 H.264 NAL units，不需要 bitmap readback，不需要 CPU image processing，也不需要 Go 侧重新编码。

新 pipeline：

```text
DisplayManager.createVirtualDisplay() or SurfaceControl.createDisplay() (once)
  -> VirtualDisplay mirrors physical screen (continuous)
  -> MediaCodec hardware H.264 encoder (continuous)
  -> NAL units over TCP to Go sidecar
  -> Go forwards NALs directly to WebRTC
```

预期提升：约 2.5 fps / 400ms latency -> 30-60 fps / <50ms latency。

## 必须保持的兼容契约

Legacy screenshot path 仍是默认 fallback，必须继续有效：

- `0x01`/`0x02` frame request/response 保持不变。
- `0x03` control 保持不变。
- 如果 `stream_start` 不受支持（旧 APK），sidecar fallback 到 `GetFrame()` polling。
- Emulator 和 ChromeOS 继续使用现有 frame/x264 pipeline。

## Display Mirroring：DisplayManager vs SurfaceControl vs MediaProjection

有三种 API 可以创建镜像实体屏幕的 VirtualDisplay。scrcpy 使用两级 fallback：

| | DisplayManager（优先） | SurfaceControl（fallback） | MediaProjection |
|---|---|---|---|
| 用户同意弹窗 | 否 | 否 | 是，系统 UI prompt |
| Shell user access | 是，hidden API | 是，hidden API | 从 shell 不可靠 |
| API level | 随方法而异 | Android 5+ | Android 5+ |
| Android 14+ | 方法可能移到 `DisplayControl` class | 同左 | 同左 |
| scrcpy 使用 | 主路径 | fallback | 从不使用 |

scrcpy 的策略（`ScreenCapture.java:127-144`）：

1. 先尝试 `DisplayManager.createVirtualDisplay(name, w, h, displayId, surface)`。
2. 失败时 fallback 到 `SurfaceControl.createDisplay()` + transaction setup。
3. 永不使用 MediaProjection。

`DeviceServer.java` 已经通过 `app_process` 以 shell user 运行，并为 `SurfaceControl` screenshot APIs 使用 reflection。因此我们沿用同样的两级方案。

### Android 版本注意事项

来自 scrcpy 的 `SurfaceControl.java` 和 `DisplayControl.java`：

- **Android 5-9**：用 `SurfaceControl.getBuiltInDisplay(0)` 获取 physical display token。
- **Android 10-13**：用 `SurfaceControl.getInternalDisplayToken()`，无参数。
- **Android 14+**：physical display methods 移到 `DisplayControl` class：`DisplayControl.getPhysicalDisplayToken(long)` 和 `getPhysicalDisplayIds()`。
- **Android 12+**：`createDisplay()` 上的 `secure` flag 可能受限。

现有 `DeviceServer.java` 已经为 screenshot capture 处理了一部分版本差异。Streaming path 也需要同样的 version-aware reflection。

## APK 变更（DeviceServer.java）

### 新 streaming mode

在现有 `FrameCapturer` backends 旁边增加 `MediaCodecStreamer` class。现有 screenshot path 继续用于 single-frame capture（agent CLI 等）；streaming 使用新路径。

**Activation：** 新 control command 用于启动/停止 stream：

```json
{"cmd": "stream_start", "width": 720, "height": 1600, "bitrate": 2000000, "fps": 30}
{"cmd": "stream_stop"}
```

Streaming active 时，设备连续 push NAL units，不再等待 `0x01` frame requests。

### 关键组件

**1. VirtualDisplay setup（两级，遵循 scrcpy）**

```java
// Tier 1: DisplayManager (preferred)
try {
    // DisplayManager.createVirtualDisplay(name, width, height, displayId, surface)
    // Mirrors the physical display identified by displayId
    virtualDisplay = displayManager.createVirtualDisplay(
        "yep-stream", width, height, displayId, inputSurface);
} catch (Exception e) {
    // Tier 2: SurfaceControl (fallback)
    Object displayToken = SurfaceControl.createDisplay("yep-stream", false);
    SurfaceControl.openTransaction();
    try {
        SurfaceControl.setDisplaySurface(displayToken, inputSurface);
        SurfaceControl.setDisplayProjection(displayToken, 0, deviceRect, displayRect);
        SurfaceControl.setDisplayLayerStack(displayToken, layerStack);
    } finally {
        SurfaceControl.closeTransaction();
    }
}
```

所有调用都通过 reflection，和 `DeviceServer.java` 中现有 screenshot backends 模式一致。

**2. MediaCodec configuration**

沿用 scrcpy 已验证的参数（`SurfaceEncoder.java:256-286`）：

```java
MediaFormat format = new MediaFormat();
format.setString(MediaFormat.KEY_MIME, MediaFormat.MIMETYPE_VIDEO_AVC);
format.setInteger(MediaFormat.KEY_WIDTH, width);
format.setInteger(MediaFormat.KEY_HEIGHT, height);
format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);               // e.g. 2 Mbps
format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);                   // scrcpy uses 60 (actual fps is variable)
format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);             // scrcpy: keyframe every 10s
format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000); // repeat after 100ms idle
// Android 7.0+:
format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);

MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);

// The encoder's input Surface — VirtualDisplay renders into this
Surface inputSurface = codec.createInputSurface();
codec.start();
```

说明：scrcpy 把 `KEY_FRAME_RATE = 60` 作为 hint，但实际 FPS 由 display refresh 和 `KEY_MAX_FPS_TO_ENCODER` 决定。`KEY_MAX_FPS_TO_ENCODER` 在 Android 10+ 是 public API，之前是 private API。我们可以用它控制真实 FPS cap。

**3. Encoder output loop**

scrcpy 使用 blocking `dequeueOutputBuffer(bufferInfo, -1)`。我们使用 bounded timeout，便于检查 stop signals：

```java
MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
while (streaming) {
    int index = codec.dequeueOutputBuffer(info, 100_000); // 100ms timeout
    if (index >= 0) {
        ByteBuffer buf = codec.getOutputBuffer(index);
        boolean isConfig = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
        boolean isKeyframe = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
        sendNalUnit(buf, info.size, isConfig, isKeyframe, info.presentationTimeUs);
        codec.releaseOutputBuffer(index, false);
    }
}
```

**4. 初始失败时降低尺寸**

如果 encoder 在产出第一帧前失败，scrcpy 会逐步降低尺寸重试（`SurfaceEncoder.java:149-182`）。Fallback sizes：2560、1920、1600、1280、1024、800。最多 3 次。我们也应这样做，因为部分硬件 encoder 会拒绝过高分辨率。

### Dynamic controls（不重启 pipeline）

MediaCodec 通过 `setParameters()` 支持 mid-stream 修改：

```json
{"cmd": "stream_bitrate", "bps": 1000000}
{"cmd": "stream_keyframe"}
```

实现：

```java
// Bitrate change — takes effect within 1-2 frames
Bundle params = new Bundle();
params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, newBitrate);
codec.setParameters(params);

// Keyframe request — next frame is an I-frame
Bundle kf = new Bundle();
kf.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
codec.setParameters(kf);
```

**FPS control：** 与 bitrate/keyframe 不同，FPS 没有 `setParameters()`。scrcpy 也不支持 mid-stream FPS 修改。可选方案：

- configure 时使用 `KEY_MAX_FPS_TO_ENCODER`，修改时需要重启 pipeline。
- Go 侧按目标 cadence drop frames，浪费但无需重启。
- 接受 FPS 主要由 bitrate 控制；低 bitrate 会让 encoder 自然产出更少高质量帧。

对于 backpressure，主要手段是降低 bitrate + 请求 keyframe。FPS 降低作为最后手段，需要 pipeline restart。

### Rotation handling

scrcpy 在 rotation change 时重启整个 capture + encode pipeline：`DisplaySizeMonitor.java:109-140` 检测 rotation，`CaptureReset.java` 调 `signalEndOfInputStream()`，`SurfaceEncoder.java` 的 loop 重启。我们也应这样做：

1. 监控 display rotation，可以 polling 或 listener。
2. 变化后：`codec.signalEndOfInputStream()` -> teardown VirtualDisplay -> 用新尺寸重新配置 -> restart。

这会造成短暂中断，但 rotation change 并不频繁。

### Wire protocol extension

新增 streaming message types：

```text
Stream status (device -> sidecar, length-prefixed JSON):
  [0x04][len u32 LE][json bytes]
  e.g. {"cmd":"stream_start","ok":true,"width":720,"height":1600,"bitrate":2000000,"fps":30}
```

```text
Stream NAL (device -> sidecar, push-based):
  [0x05][flags u8][pts u64 LE][len u32 LE][H.264 NAL bytes]

  flags:
    bit 0: keyframe (1 = IDR frame, 0 = P-frame)
    bit 1: config (1 = SPS/PPS, 0 = frame data)
```

`0x05` 用来区分 stream data 和 `0x02` JPEG frame responses。不 streaming 时，现有 `0x01`/`0x02` request-response 协议仍可用于 single-frame screenshots。

`0x04` 提供明确的 start/failure reporting，让 sidecar 能快速决定使用 MediaCodec 还是 fallback polling。

PTS（presentation timestamp，microseconds）用于 WebRTC 侧正确 timing。scrcpy 使用类似的 12-byte header：8-byte PTS+flags（flags 在 top 2 bits）+ 4-byte size（`Streamer.java:85-109`）。我们的格式略有不同，把 flags byte 单独拆出，解析更简单。

`flags` byte 让 Go 侧无需解析 H.264 就能做 drop decision：

- 总是 forward `config` packets（SPS/PPS），它们是初始化 decoder 必需的。
- 拥塞时可安全 drop non-keyframe packets。
- Drop 后请求 keyframe 重新同步。

## Go Sidecar 变更（device-bridge）

### AndroidDevice 增加 stream mode

`AndroidDevice` 增加 `StartStream()` / `StopStream()`。Streaming 时：

- 向 APK 发送 `stream_start` command。
- 从 poll-based `GetFrame()` 切换到 push-based NAL reader。
- 通过新的 `NalSource` 暴露 NALs，类似 `FrameSource`。

```go
type NalUnit struct {
    Data     []byte
    Keyframe bool
    Config   bool   // SPS/PPS
    PTS      int64  // microseconds
}

type NalSource struct {
    // Same subscribe/unsubscribe pattern as FrameSource
}
```

### Pipeline bypass

实体设备使用 MediaCodec streaming 时，`signaling.go` 中的 pipeline 从：

```text
FrameSource -> ScaleAndConvertToI420 -> H264Encoder.Encode -> WriteVideoSample
```

变成：

```text
NalSource -> WriteVideoSample (direct passthrough)
```

`FrameSource` / `H264Encoder` path 继续用于 emulators（gRPC screenshots -> x264）。

`SignalingHandler` / `runPipeline` 需要支持两种模式。方案：

- **Interface approach：** 定义 `VideoSource` interface，暴露 `Subscribe()` / `Unsubscribe()`；`FrameSource`+encoder 和 `NalSource` 都实现。
- **Flag approach：** `runPipeline` 根据 device type 选择对应 loop。

Interface approach 更干净，因为 signaling handler 不应该关心 device types。

### Backpressure 与 adaptive quality

**scrcpy 的做法：** blocking。`dequeueOutputBuffer(-1)` 阻塞直到 consumer 读取。不 drop frame，也不自适应画质。socket 慢时 encoder 停住；broken pipe 时退出。

**我们需要更多控制：** 路径会经过 WebRTC 和可能较慢的移动网络，不是本地 USB socket。Go 侧应主动管理画质。

**拥塞检测信号：**

1. **WebRTC RTCP feedback**：浏览器检测到丢帧时，Pion 会收到 PLI（Picture Loss Indication）。`peer.go` 中已通过 `ReadRTCP()` 处理。
2. **NAL queue depth**：subscriber channel 堆积说明 frames 到达速度超过发送速度。
3. **Write errors**：`WriteVideoSample` 失败表示 transport congestion。

**响应策略（逐级）：**

```text
1. Mild congestion (queue > 2 NALs):
   -> Reduce bitrate by 25%
   -> Send {"cmd": "stream_bitrate", "bps": <reduced>}

2. Moderate congestion (queue > 5 NALs or PLI received):
   -> Request keyframe + drop queued non-keyframe NALs
   -> Send {"cmd": "stream_keyframe"}

3. Severe congestion (sustained for >2s):
   -> Drop to minimum bitrate (500kbps)
   -> Request keyframe, flush queue

4. Recovery (queue empty for >1s):
   -> Ramp bitrate back up by 25% per second
```

说明：FPS 降低需要 pipeline restart，因为没有 mid-stream `setParameters`。因此优先用 bitrate reduction。FPS change 是最后手段，需要 `stream_stop` + `stream_start`。

**NAL dropping rules：**

- 永不 drop SPS/PPS config packets。
- 永不 drop keyframes（IDR）。
- 可 drop P-frames，但之后必须请求 keyframe。
- 一旦发生 drop，下一个 forward frame 必须是 keyframe。

### Resolution changes

修改分辨率需要重建 VirtualDisplay 和 MediaCodec；不能 mid-stream resize，scrcpy 也会重启完整 pipeline。Go 侧发送：

```json
{"cmd": "stream_stop"}
{"cmd": "stream_start", "width": 540, "height": 1200, "bitrate": 1000000, "fps": 30}
```

这会造成短暂中断，约 100ms。应谨慎使用，优先调整 bitrate。

## 兼容性与 fallback

MediaCodec path 需要：

- `DisplayManager.createVirtualDisplay()` 或 `SurfaceControl.createDisplay()`：Android 5+，shell user 可用。
- 支持 `COLOR_FormatSurface` 的 `MediaCodec`：Android 5+。

scrcpy 在初始 encoder 失败时会降低尺寸重试（2560 -> 1920 -> 1600 -> 1280 -> 1024 -> 800），最多 3 次。我们也这样做。如果仍失败，就 fallback 到现有 screenshot-polling path。APK 会用 error JSON 响应 `stream_start`，Go 侧据此改用 `GetFrame()` polling。

## 实现阶段

每个 phase/slice landing 前都必须有测试门禁。

### Phase 1：APK 中的 MediaCodec streaming

1. 在 `DeviceServer.java` 中增加 `MediaCodecStreamer` class：
   - 两级 VirtualDisplay setup：DisplayManager（优先）-> SurfaceControl（fallback）
   - Version-aware reflection：Android 5-9、10-13、14+ display token APIs
   - 使用 `createInputSurface()` 的 MediaCodec H.264 encoder
   - 读取 NAL units，并通过 `0x05` messages 发送
   - 初始 encoder 失败时按 scrcpy 模式降低尺寸重试
2. 增加 `stream_start` / `stream_stop` / `stream_bitrate` / `stream_keyframe` command handlers。
3. 增加 rotation detection -> pipeline restart。
4. 独立测试：`adb forward` + 读取 raw NAL output，用 ffprobe/ffplay 验证。

### Phase 2：Go sidecar NAL passthrough + fallback

1. 在 `conn` package 中解析 `0x05` message。
2. 增加带 subscribe/unsubscribe 的 `NalSource`，API 对齐 `FrameSource`。
3. 为 `AndroidDevice` 增加 `StartStream()` / `StopStream()`。
4. 修改 `runPipeline`，支持 NAL passthrough mode，跳过 JPEG decode + x264。
5. 测试：real device -> WebRTC -> browser video，达到 30fps。

### Phase 2A 当前 slice 状态

- 增加了 `0x04` / `0x05` protocol constants 和 framing support。
- 在 `device-bridge` 中增加 Android stream controls 和 NAL source path。
- 增加 automatic fallback：stream startup timeout/error 后回到 screenshot polling。
- 保持 legacy API 行为不变：stream mode 不可用时 `GetFrame` path 不变。
- APK stream startup 先尝试 `DisplayManager.createVirtualDisplay()`，再 fallback 到 `SurfaceControl.createDisplay()`。
- 增加 startup resolution downgrade retries：初始尺寸 + 最多 3 个更小尺寸。
- 增加 display-size change detection，并自动重启 encoder/display pipeline。
- 增加 `internal/ipc` bridge gate tests，覆盖 stream-capable start path 和 fallback path。
- 在 sidecar 中增加 H.264 payload normalization：WebRTC packetization 前把 `avcC` config + length-prefixed NALs 转为 Annex-B。
- 增加 stream-format diagnostics：`YEP_BRIDGE_STREAM_DEBUG=true` 时记录 physical-device debug runs 的 config/keyframe payload shape 和 conversion path。
- 更新设备端 encoder config：优先 H.264 baseline profile，并在 sync frames 上 prepend SPS/PPS，提高 browser decoder 兼容性和长时间稳定性。

### Phase 3：Adaptive quality

1. 增加 congestion detection：queue depth monitoring、PLI forwarding。
2. 实现 progressive backpressure：bitrate -> keyframe request -> resolution。
3. 增加 recovery ramp-up。
4. 连接 Pion RTCP PLI -> APK `stream_keyframe` command。

### Phase 3A 当前 slice 状态

- 将 WebRTC RTCP feedback（`PLI`/`FIR`）转发到 sidecar pipeline。
- 在 NAL pipeline 中增加 queue-depth congestion detection。
- 实现 progressive bitrate reduction：每次 25%，最低 500 kbps。
- 在 moderate/severe congestion 下实现 keyframe request + non-keyframe drop-until-keyframe。
- 实现 bitrate recovery ramp：queue 稳定后，每秒按 25% 回升到 baseline。

本 slice 已知缺口：

- Sustained congestion 下的 resolution/FPS restart fallback 尚未接入；当前只使用 bitrate + keyframe controls。

### Phase 3B 当前 slice 状态

- 增加 sustained-congestion fallback，通过 `stream_stop` + `stream_start` 降到更低 stream profile。
- 增加 profile ladder，协调 resolution/FPS/bitrate steps 和 restart cooldowns。
- queue pressure 清除后，基于稳定性向更高 profile recovery restart。
- 为 profile generation 和 restart wiring 增加 `internal/ipc` unit gates。

### Phase 4：Polish

1. 自动检测 device capability：尝试 `stream_start`，失败则 fallback 到 polling。
2. Client UI 显示当前 stream stats：fps、bitrate、resolution。
3. Client controls：手动画质覆盖，提供 low/medium/high presets。
4. Benchmark：在多台设备上测量端到端 latency 和 fps。

## Test Gates By Slice

最低测试门禁：

1. **Protocol gate**（`packages/device-bridge/internal/conn/framing_test.go`）
   - Legacy framing 仍通过。
   - `TypeStreamStatus (0x04)` round-trip。
   - `TypeStreamNAL (0x05)` round-trip。

2. **Android transport gate**（`packages/device-bridge/internal/device/android_device_test.go`）
   - Stream unsupported -> timeout -> fallback 到 `GetFrame` 仍可用。
   - Stream supported -> NAL reception 可用。

3. **Bridge pipeline gate**（`packages/device-bridge/internal/ipc/...`）
   - Android stream path 能启动。
   - Stream unavailable 时 fallback path 仍可用。

4. **Browser E2E gate**（`packages/client/e2e/*.spec.ts`）
   - 现有 emulator 和 physical-android Playwright streaming tests 必须保持 green。
   - APK transport override E2E 仍是回归测试要求。
   - Adaptive quality regression gate：`pnpm test:e2e:emulator:apk:adaptive` 必须显示 downshift 和 recovery/upshift profile events。

5. **Long-duration reliability soak**（可选，release 前推荐）
   - Physical Android stream 在可配置时长内保持 connected，playback 持续推进。
   - Opt-in env vars：
     - `YEP_E2E_ANDROID_LONG_STREAM=true`
     - `YEP_E2E_ANDROID_LONG_STREAM_MS`（默认 `120000`）
     - `YEP_E2E_ANDROID_LONG_STREAM_POLL_MS`（默认 `1000`）
     - `YEP_E2E_ANDROID_LONG_STREAM_STALL_MS`（默认 `15000`）
     - `YEP_E2E_ANDROID_LONG_STREAM_STARTUP_MS`（默认 `45000`）
     - `YEP_E2E_ANDROID_LONG_STREAM_NUDGE_MS`（默认 `4000`）
   - 运行：`pnpm test:e2e:android:soak`

## 参考：scrcpy 源码

本地 clone：`~/code/references/scrcpy/`

`server/src/main/java/com/genymobile/scrcpy/` 中关键文件：

| 文件 | 重点 |
|------|------|
| `video/SurfaceEncoder.java` | Encoding loop（197-224）、MediaFormat config（256-286）、size downgrade retry（149-182） |
| `video/ScreenCapture.java` | 两级 VirtualDisplay creation（127-144）、display projection setup（204-212）、rotation handling |
| `wrappers/SurfaceControl.java` | createDisplay、setDisplaySurface/Projection/LayerStack 的 reflection wrappers（40-121） |
| `wrappers/DisplayControl.java` | Android 14+ physical display token APIs（49-81） |
| `wrappers/DisplayManager.java` | DisplayManager.createVirtualDisplay reflection（163-182） |
| `device/Streamer.java` | NAL framing：8-byte PTS+flags + 4-byte size header（85-109） |
| `video/CaptureReset.java` | 通过 signalEndOfInputStream 重启 pipeline（14-36） |
| `video/DisplaySizeMonitor.java` | Rotation/size change detection（41-77、109-140） |
| `video/NewDisplayCapture.java` | 替代方案：new virtual display，不镜像实体屏幕 |

## 文件位置

| 组件 | 路径 |
|------|------|
| APK source | `packages/android-device-server/app/src/main/java/com/yepanywhere/DeviceServer.java` |
| Go device abstraction | `packages/device-bridge/internal/device/android_device.go` |
| Go frame source | `packages/device-bridge/internal/device/frame_source.go` |
| Go encoder（emulator path） | `packages/device-bridge/internal/encoder/h264.go` |
| Go WebRTC pipeline | `packages/device-bridge/internal/stream/signaling.go` |
| Wire protocol | `packages/device-bridge/internal/conn/framing.go` |
| scrcpy reference | `~/code/references/scrcpy/` |
| 本文档 | `docs/project/device-bridge-mediacodec.md` |
