# AcFan 视频下载分析报告

## 网站技术架构

### 前端
- **框架**: Nuxt.js (SSR 服务端渲染)
- **播放器**: xgplayer (西瓜播放器/字节跳动)
- **流媒体**: HLS (.m3u8 + .ts 分片)

### 视频加载流程
```
1. 用户访问 /anime/play/{videoId}
2. 服务端渲染 HTML，将视频信息注入 window.__NUXT__
3. 前端 xgplayer 初始化，读取 __NUXT__ 中的 playPath (m3u8地址)
4. 播放器加载 m3u8，获取 TS 分片列表
5. 逐片解密(如加密)并播放
```

### SSR 数据结构
```json
{
  "videoId": 112927,
  "title": "视频标题",
  "videoUrl": "相对路径/m3u8",
  "playPath": "https://domain/path/video.m3u8",
  "checkSum": "0d9fe80323b2b3c6246af2fbc8e423ea",
  "coverImg": ["封面图"],
  "playTime": 1130,        // 总时长(秒)
  "size": 296962679        // 文件大小(字节)
}
```

### 加密方案
- **方式**: HLS AES-128 全段加密
- **密钥声明**: `#EXT-X-KEY:METHOD=AES-128,URI="http://domain/enc.key",IV=0x00000000000000000000000000000000`
- **密钥 URI**: `http://domain/enc.key` — 这是一个**虚假地址**，实际密钥通过 xgplayer 自定义解密器获取
- **IV**: 全零 (0x00000000000000000000000000000000)
- **解密调用**: xgplayer → IExternalDecryptor.decrypt(data, key, iv) → Web Crypto AES-CBC

### 安全防护
1. **WAF/反爬**: Node.js 直接 fetch 会被断开连接 (ECONNRESET)
2. **混合内容**: `http://domain/enc.key` 被浏览器阻止
3. **自定义解密器**: 密钥不在 m3u8 中，需要 xgplayer 内部解析

---

## 解决方案

### 方案一：浏览器 MSE 拦截（推荐 ★★★★★）

**原理**: 播放器在浏览器中解密视频后，通过 MediaSource Extensions 将数据喂给 `<video>` 元素。我们拦截 `SourceBuffer.appendBuffer()` 捕获已解密的数据。

**使用方法**:
1. 打开视频页面
2. 按 F12 打开开发者工具 → Console
3. 粘贴 `video-capture.js` 的全部代码并回车
4. 调用 `autoDownloadVideo("文件名.mp4")` 
5. 等待视频播放完毕，文件自动下载

**优点**: 
- 100% 可靠，绕过所有加密
- 无需分析密钥
- 操作简单

**缺点**: 
- 需要完整播放一遍视频
- 不能批量下载

---

### 方案二：Playwright 自动化（推荐 ★★★★）

**用法**:
```bash
npm install playwright
npx playwright install chromium
node download-cli.js "https://acpcssr.47u3j9k8.work/anime/play/112927"
```

**原理**: 与方案一相同，但通过 Playwright 自动化浏览器操作。

---

### 方案三：M3U8 直接下载（需要密钥）

如果能够获取到解密密钥，可以使用 `m3u8-downloader.js`:

```bash
node m3u8-downloader.js "M3U8地址" "AES128密钥(32位hex)" "./输出目录"
```

**密钥获取方法**（待验证）:
1. 通过 xgplayer 实例内部获取
2. 拦截 `IExternalDecryptor.decrypt()` 调用
3. 从后端 API 的特定字段获取（非 checkSum）

---

## 文件说明

| 文件 | 用途 |
|------|------|
| `video-capture.js` | 浏览器控制台脚本，MSE 拦截方案 |
| `download-cli.js` | Playwright 自动化下载（Node.js） |
| `m3u8-downloader.js` | M3U8 直接下载 + 密钥推导 |

---

## 技术细节

### xgplayer 解密流程
```
1. ManifestLoader 解析 m3u8
2. SegmentLoader 下载 TS 分片 + 密钥文件
3. BufferService.decryptBuffer() → Decryptor.decrypt()
4. Decryptor._decryptData():
   - 如果有 externalDecryptor → 调用自定义解密器
   - 否则 → Web Crypto API AES-CBC 解密
5. 解密后的数据通过 SourceBuffer.appendBuffer() 送入 video 元素
```

### MSE 拦截原理
```
MediaSource.addSourceBuffer()   ← 我们在此 hook
  └─ SourceBuffer.appendBuffer() ← 在此捕获已解密数据
       └─ video 元素显示画面
```

### 密钥推导尝试记录
| 方法 | 结果 |
|------|------|
| checkSum hex解码 | ❌ OperationError |
| 全零密钥 | ❌ OperationError |
| 全1密钥 | ❌ OperationError |
| 常见测试密钥 | ❌ OperationError |
| checkSum UTF-8 | ❌ OperationError |

**结论**: 密钥不由 checkSum 推导，由 xgplayer 自定义解密器内部生成或从其他 API 获取。
