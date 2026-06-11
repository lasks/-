/**
 * AcFan 视频下载器 - MSE 拦截方案
 * 
 * 原理：利用浏览器自身解密能力，通过拦截 MediaSource 的 buffer append 操作，
 * 捕获已解密的视频数据，合并后保存为 MP4 文件。
 * 
 * 用法：
 *   1. 打开目标视频页面
 *   2. 在浏览器控制台粘贴此脚本
 *   3. 调用 downloadVideo() 开始下载
 * 
 * 或者通过 Playwright 自动化运行
 */

(function() {
  'use strict';

  const chunks = [];
  let totalSize = 0;
  let isCapturing = false;
  let originalAddSourceBuffer = null;
  let originalAppendBuffer = null;

  // 拦截 MediaSource.prototype.addSourceBuffer
  function hookMediaSource() {
    if (originalAddSourceBuffer) return; // already hooked

    originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mimeType) {
      console.log('[VideoCapture] SourceBuffer created:', mimeType);
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      
      // 只拦截视频/音频 buffer
      if (mimeType.includes('video') || mimeType.includes('audio')) {
        hookSourceBuffer(sourceBuffer, mimeType);
      }
      return sourceBuffer;
    };
  }

  // 拦截 SourceBuffer.prototype.appendBuffer
  function hookSourceBuffer(sourceBuffer, mimeType) {
    if (sourceBuffer.__hooked) return;
    sourceBuffer.__hooked = true;

    const originalAppend = sourceBuffer.appendBuffer.bind(sourceBuffer);
    sourceBuffer.appendBuffer = function(buffer) {
      if (isCapturing) {
        const data = new Uint8Array(buffer);
        chunks.push(data);
        totalSize += data.length;
        
        // 每 50 个片段打印一次进度
        if (chunks.length % 50 === 0) {
          console.log(`[VideoCapture] 已捕获 ${chunks.length} 个片段, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        }
      }
      return originalAppend(buffer);
    };
  }

  // 开始捕获
  window.startCapture = function() {
    if (isCapturing) {
      console.log('[VideoCapture] 已在捕获中...');
      return;
    }
    chunks.length = 0;
    totalSize = 0;
    isCapturing = true;
    hookMediaSource();
    console.log('[VideoCapture] 开始捕获视频数据...');
    console.log('[VideoCapture] 提示：请刷新页面后播放视频，或等待当前视频继续播放');
  };

  // 停止捕获并下载
  window.stopCaptureAndDownload = function(filename) {
    isCapturing = false;
    
    if (chunks.length === 0) {
      console.log('[VideoCapture] 没有捕获到数据！请确保：\n' +
        '1. 已调用 startCapture()\n' +
        '2. 视频正在播放\n' +
        '3. 页面已刷新（如果是在播放器加载后才调用 startCapture）');
      return;
    }

    // 合并所有片段
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // 创建 Blob 并下载
    const blob = new Blob([merged], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'video.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[VideoCapture] 下载完成！文件大小: ${(totalLength / 1024 / 1024).toFixed(2)} MB`);
  };

  // 一键下载：等待视频加载后自动捕获
  window.downloadVideo = async function(customFilename) {
    startCapture();
    
    // 如果页面已经加载了视频，提示刷新
    console.log('[VideoCapture] 正在重新加载页面以捕获完整视频...');
    location.reload();
    
    // 页面重新加载后，需要用户手动调用 stopCaptureAndDownload()
    // 或者我们可以监听视频结束事件
    return new Promise((resolve) => {
      window.addEventListener('load', () => {
        console.log('[VideoCapture] 页面加载完成，正在等待视频播放...');
        console.log('[VideoCapture] 视频播放完毕后，请在控制台执行: stopCaptureAndDownload("文件名.mp4")');
      });
    });
  };

  // 自动模式：检测视频结束自动下载
  window.autoDownloadVideo = function(filename) {
    startCapture();
    
    // 监听视频结束
    const checkInterval = setInterval(() => {
      const video = document.querySelector('video');
      if (video && video.duration && video.currentTime >= video.duration - 0.5) {
        clearInterval(checkInterval);
        setTimeout(() => {
          stopCaptureAndDownload(filename || 'video.mp4');
        }, 1000);
      }
    }, 2000);
    
    console.log('[VideoCapture] 自动模式已启动，视频播放完毕后将自动下载');
  };

  console.log('[VideoCapture] ✅ 视频捕获工具已注入！');
  console.log('[VideoCapture] 使用方法:');
  console.log('  downloadVideo("文件名.mp4")      - 一键刷新页面并开始捕获');
  console.log('  startCapture()                   - 手动开始捕获');
  console.log('  stopCaptureAndDownload("文件名")  - 停止并下载');
  console.log('  autoDownloadVideo("文件名")       - 自动检测视频结束并下载');
})();
