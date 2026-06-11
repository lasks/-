/**
 * AcFan 视频下载器 - Playwright 自动化版本
 * 
 * 用法：
 *   node download-cli.js <视频页面URL>
 * 
 * 示例：
 *   node download-cli.js "https://acpcssr.47u3j9k8.work/anime/play/112927"
 * 
 * 依赖：
 *   npm install playwright
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 视频捕获脚本（注入浏览器） ====================
const CAPTURE_SCRIPT = `
(function() {
  if (window.__videoCaptureInjected) return;
  window.__videoCaptureInjected = true;

  const chunks = [];
  let isCapturing = false;

  // Hook MediaSource
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function(mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    if ((mimeType.includes('video') || mimeType.includes('audio')) && !sb.__hooked) {
      sb.__hooked = true;
      const origAppend = sb.appendBuffer.bind(sb);
      sb.appendBuffer = function(buffer) {
        if (window.__captureActive) {
          const data = new Uint8Array(buffer);
          chunks.push(Array.from(data));
        }
        return origAppend(buffer);
      };
    }
    return sb;
  };

  window.__startCapture = () => {
    chunks.length = 0;
    window.__captureActive = true;
    return 'capture_started';
  };

  window.__stopCapture = () => {
    window.__captureActive = false;
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return { size: totalLen, base64: btoa(String.fromCharCode(...merged)) };
  };
})();
`;

// ==================== 主流程 ====================
async function downloadVideo(url, outputDir) {
  console.log(`\n🎬 AcFan 视频下载器`);
  console.log(`📍 目标: ${url}\n`);

  const browser = await chromium.launch({
    headless: false, // 需要显示浏览器以便视频加载
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });

  const page = await context.newPage();

  // 拦截请求日志
  page.on('response', async (response) => {
    const reqUrl = response.url();
    if (reqUrl.includes('.m3u8')) {
      const body = await response.text();
      console.log(`📋 M3U8 获取成功 (${body.length} 字节)`);
      // 保存 m3u8 内容
      const m3u8Path = path.join(outputDir, 'playlist.m3u8');
      fs.writeFileSync(m3u8Path, body);
    }
  });

  try {
    // 1. 打开页面
    console.log('⏳ 正在加载页面...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // 2. 从 __NUXT__ 提取视频信息
    const videoInfo = await page.evaluate(() => {
      const nuxt = window.__NUXT__;
      if (!nuxt) return null;
      
      // 查找视频详情数据
      for (const key of Object.keys(nuxt.data || {})) {
        if (key.startsWith('video-detail') || key.startsWith('$f')) {
          const data = nuxt.data[key];
          if (data?.data?.title && data?.data?.playPath) {
            return {
              title: data.data.title,
              videoUrl: data.data.videoUrl,
              playPath: data.data.playPath,
              checkSum: data.data.checkSum,
              coverImg: data.data.coverImg?.[0],
              duration: data.data.playTime,
              size: data.data.size,
            };
          }
        }
      }
      return null;
    });

    if (videoInfo) {
      console.log(`📹 标题: ${videoInfo.title}`);
      console.log(`🔗 M3U8: ${videoInfo.playPath}`);
      console.log(`🔑 CheckSum: ${videoInfo.checkSum}`);
      console.log(`⏱️ 时长: ${Math.round(videoInfo.duration / 60)} 分钟`);
      console.log(`📦 大小: ${(videoInfo.size / 1024 / 1024).toFixed(0)} MB`);
    } else {
      console.log('⚠️ 未能从页面提取视频信息，将尝试直接捕获');
    }

    // 3. 注入捕获脚本
    await page.evaluate(CAPTURE_SCRIPT);

    // 4. 刷新页面以从头捕获（需要 hook 在 MediaSource 创建之前）
    console.log('\n🔄 刷新页面以从头捕获视频数据...');
    await page.evaluate(CAPTURE_SCRIPT); // 再次注入（刷新前）
    await page.evaluate(() => window.__startCapture());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(CAPTURE_SCRIPT); // 刷新后注入
    await page.evaluate(() => window.__startCapture());

    // 5. 等待视频加载并播放
    console.log('⏳ 等待视频播放器加载...');
    
    // 等待视频元素出现
    await page.waitForSelector('video', { timeout: 15000 }).catch(() => {
      console.log('⚠️ 未检测到 video 元素，尝试等待播放器...');
    });

    // 等待视频播放
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2;
    }, { timeout: 20000 }).catch(() => {
      console.log('⚠️ 视频加载超时，尝试继续...');
    });

    // 6. 获取视频时长
    const duration = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.duration : 0;
    });

    if (duration > 0) {
      console.log(`⏱️ 视频时长: ${Math.round(duration)} 秒`);
      console.log(`⏳ 预计下载时间: ${Math.round(duration * 1.5)} 秒`);
    }

    // 7. 等待视频播放完毕
    console.log('\n▶️ 正在播放并捕获视频数据...');
    console.log('（请勿关闭浏览器窗口）\n');

    // 尝试点击播放按钮
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && v.paused) v.play().catch(() => {});
      // 关闭可能弹出的广告
      setTimeout(() => {
        const closeBtns = document.querySelectorAll('[class*="close"], [class*="ad"]');
        closeBtns.forEach(b => b.click());
      }, 3000);
    });

    // 等待视频播放结束或超时
    const maxWaitMs = Math.max(duration * 1000 * 1.5, 60000);
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.ended;
    }, { timeout: maxWaitMs }).catch(() => {
      console.log('⚠️ 未检测到视频结束（可能是直播或超时），将手动停止捕获');
    });

    // 8. 获取捕获的数据
    console.log('\n📦 正在导出视频数据...');
    const capturedData = await page.evaluate(() => window.__stopCapture());

    if (!capturedData || capturedData.size === 0) {
      console.log('❌ 未捕获到视频数据！');
      console.log('\n💡 备选方案：');
      console.log('  1. 在浏览器控制台运行 video-capture.js 中的代码');
      console.log('  2. 确保视频在 MS-DOS 模式下播放');
      return null;
    }

    // 9. 保存文件
    const filename = videoInfo 
      ? sanitizeFilename(videoInfo.title) + '.mp4'
      : 'downloaded_video.mp4';
    const filePath = path.join(outputDir, filename);

    const buffer = Buffer.from(capturedData.base64, 'base64');
    fs.writeFileSync(filePath, buffer);

    const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
    console.log(`\n✅ 下载完成！`);
    console.log(`📁 文件: ${filePath}`);
    console.log(`📦 大小: ${sizeMB} MB`);

    return filePath;

  } catch (error) {
    console.error(`\n❌ 下载失败: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

// ==================== M3U8 下载备选方案 ====================
async function downloadM3U8Segments(m3u8Url, outputDir) {
  console.log('\n📋 M3U8 直接下载模式...');
  
  // 下载 m3u8 文件
  const response = await fetch(m3u8Url);
  const m3u8Content = await response.text();
  
  // 解析 m3u8
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const segments = m3u8Content.split('\n')
    .filter(line => line.trim() && !line.startsWith('#') && line.endsWith('.ts'));
  
  console.log(`📋 共 ${segments.length} 个 TS 片段`);
  
  const tsDir = path.join(outputDir, 'ts_segments');
  fs.mkdirSync(tsDir, { recursive: true });
  
  // 下载所有段
  const totalSegments = segments.length;
  for (let i = 0; i < totalSegments; i++) {
    const seg = segments[i].trim();
    const segUrl = seg.startsWith('http') ? seg : baseUrl + seg;
    
    process.stdout.write(`\r⬇️ 下载片段 ${i + 1}/${totalSegments}...`);
    
    const segRes = await fetch(segUrl);
    const segData = Buffer.from(await segRes.arrayBuffer());
    fs.writeFileSync(path.join(tsDir, seg), segData);
  }
  
  console.log(`\n✅ TS 片段下载完成: ${tsDir}`);
  
  // 合并 TS 文件
  console.log('🔗 合并 TS 文件...');
  const mergedPath = path.join(outputDir, 'merged.ts');
  const mergedStream = fs.createWriteStream(mergedPath);
  
  for (const seg of segments) {
    const segPath = path.join(tsDir, seg.trim());
    if (fs.existsSync(segPath)) {
      mergedStream.write(fs.readFileSync(segPath));
    }
  }
  mergedStream.end();
  
  console.log(`✅ 合并完成: ${mergedPath}`);
  console.log('💡 提示: 如果文件已加密，请使用 ffmpeg 配合密钥进行解密');
  
  return mergedPath;
}

// ==================== 工具函数 ====================
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'video';
}

// ==================== CLI 入口 ====================
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('用法: node download-cli.js <视频页面URL> [输出目录]');
    console.log('示例: node download-cli.js "https://acpcssr.47u3j9k8.work/anime/play/112927" ./downloads');
    process.exit(1);
  }

  const url = args[0];
  const outputDir = args[1] || path.join(__dirname, 'downloads');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('🔍 分析目标网站...');
  console.log(`📂 输出目录: ${outputDir}`);
  
  await downloadVideo(url, outputDir);
}

main().catch(console.error);

export { downloadVideo, downloadM3U8Segments };
