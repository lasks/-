/**
 * 直接下载 M3U8 + AES-128 解密合并
 * 密钥已从浏览器中提取
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function downloadM3U8(url, keyHex, outDir) {
  console.log('🎬 M3U8 直接下载解密\n');
  outDir = outDir || path.join(__dirname, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 下载 m3u8
  console.log('📋 下载 M3U8...');
  const m3u8Resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://acpcssr.47u3j9k8.work/',
      'Origin': 'https://acpcssr.47u3j9k8.work',
    }
  });
  const m3u8Text = await m3u8Resp.text();
  fs.writeFileSync(path.join(outDir, 'playlist.m3u8'), m3u8Text);

  // 2. 解析 m3u8
  const lines = m3u8Text.split('\n');
  const segments = [];
  let keyUri = null, ivStr = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-KEY:')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const ivMatch = line.match(/IV=(0x[a-fA-F0-9]+)/);
      if (uriMatch) keyUri = uriMatch[1];
      if (ivMatch) ivStr = ivMatch[1];
    }
    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1].split(',')[0]);
      i++;
      if (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('#')) {
        segments.push({ duration: dur, url: lines[i].trim() });
      }
    }
  }

  console.log(`📋 分片数: ${segments.length}`);
  console.log(`🔑 密钥URI: ${keyUri}`);
  console.log(`🔑 实际密钥: ${keyHex}\n`);

  // 3. 准备密钥和IV
  const key = Buffer.from(keyHex, 'hex');
  const iv = ivStr
    ? Buffer.from(ivStr.replace('0x', ''), 'hex')
    : Buffer.alloc(16, 0);

  // 4. 下载并解密所有分片
  const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  const decryptedParts = [];
  let totalSize = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segUrl = seg.url.startsWith('http') ? seg.url : baseUrl + seg.url;

    process.stdout.write(`\r⬇️ ${i + 1}/${segments.length} [${Math.round((i + 1) / segments.length * 100)}%] ${(totalSize / 1048576).toFixed(1)}MB`);

    let segData;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const resp = await fetch(segUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://acpcssr.47u3j9k8.work/',
          }
        });
        segData = Buffer.from(await resp.arrayBuffer());
        break;
      } catch (e) {
        if (retry === 2) throw e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    totalSize += segData.length;

    // 解密 (AES-128-CBC)
    try {
      // 每个分片可能用不同的 IV (基于序列号)
      let segIv;
      if (ivStr) {
        segIv = iv;
      } else {
        segIv = Buffer.alloc(16, 0);
        // HLS 规范: 序列号为 0 的片用全零 IV，后续片用序列号递增
        const seqNum = i; // mediaSequence 一般为 0
        segIv.writeUInt32BE(seqNum, 12);
      }

      const decipher = crypto.createDecipheriv('aes-128-cbc', key, segIv);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(segData), decipher.final()]);
      decryptedParts.push(decrypted);
    } catch (e) {
      console.log(`\n⚠️ 片段${i} 解密失败: ${e.message}，保留原始数据`);
      decryptedParts.push(segData);
    }
  }

  console.log(`\n✅ 下载完成，共 ${(totalSize / 1048576).toFixed(0)}MB\n`);

  // 5. 合并
  console.log('🔗 合并...');
  const merged = Buffer.concat(decryptedParts);
  const fn = 'video_' + Date.now() + '.ts';
  const fp = path.join(outDir, fn);
  fs.writeFileSync(fp, merged);

  console.log(`✅ 完成! 📁 ${fp}`);
  console.log(`📦 ${(merged.length / 1048576).toFixed(2)} MB`);
  return fp;
}

// 从页面URL获取m3u8
async function getM3U8Url(pageUrl) {
  const resp = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const html = await resp.text();
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*({.*?});/s);
  if (!nuxtMatch) return null;
  const ppMatch = nuxtMatch[1].match(/"playPath"\s*:\s*"([^"]+)"/);
  return ppMatch ? ppMatch[1] : null;
}

// ==================== CLI ====================
async function main() {
  const args = process.argv.slice(2);
  const pageUrl = args[0];
  const keyHex = args[1];
  const outDir = args[2] || path.join(__dirname, 'downloads');

  if (!pageUrl) {
    console.log('用法:');
    console.log('  node m3u8-dl.js <页面URL> <密钥hex> [输出目录]');
    console.log('  node m3u8-dl.js <m3u8URL> <密钥hex>');
    console.log('\n示例:');
    console.log('  node m3u8-dl.js "https://acpcssr.../play/112927" c7719993cb5b81ceb148f4a205d48f05');
    process.exit(1);
  }

  let m3u8Url = pageUrl;
  if (pageUrl.includes('/play/') || pageUrl.includes('/anime/')) {
    console.log('🔍 从页面提取 m3u8 地址...');
    const extracted = await getM3U8Url(pageUrl);
    if (extracted) {
      m3u8Url = extracted;
      console.log('✅ ' + m3u8Url);
    } else {
      console.log('⚠️ 提取失败，尝试直接作为 m3u8 使用');
    }
  }

  if (!keyHex || keyHex.length !== 32) {
    console.log('\n⚠️ 请提供 32位 hex 密钥 (16字节 AES-128)');
    console.log('已知密钥: c7719993cb5b81ceb148f4a205d48f05');
    process.exit(1);
  }

  await downloadM3U8(m3u8Url, keyHex, outDir);
}

main().catch(console.error);
