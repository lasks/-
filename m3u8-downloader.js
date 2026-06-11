/**
 * AcFan 视频下载器 - M3U8 直接下载 + 密钥推导
 * 
 * 尝试多种方式推导 AES-128 解密密钥
 * 适用于 xgplayer + "http://domain/enc.key" 模式的视频站
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 密钥推导方法 ====================

/**
 * 方法1: checksum 直接作为 hex key
 */
function deriveKeyFromCheckSum(checkSum) {
  if (!checkSum || checkSum.length !== 32) return null;
  return Buffer.from(checkSum, 'hex');
}

/**
 * 方法2: MD5 of various strings
 */
function deriveKeyFromMD5(...strings) {
  const input = strings.filter(Boolean).join('');
  return crypto.createHash('md5').update(input).digest(); // MD5 = 128 bits = AES-128
}

/**
 * 方法3: SHA-1 truncated to 128 bits
 */
function deriveKeyFromSHA1(str) {
  return crypto.createHash('sha1').update(str).digest().slice(0, 16);
}

/**
 * 方法4: 固定常见密钥
 */
const COMMON_KEYS = [
  Buffer.alloc(16, 0),                                    // 全零
  Buffer.from('0000000000000000', 'utf8'),                 // 8字节零
  Buffer.from('1234567890123456', 'utf8'),                 // 常见测试密钥
];

// ==================== AES-128-CBC 解密 ====================

function aes128cbcDecrypt(encryptedData, key, iv = Buffer.alloc(16, 0)) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

/**
 * 验证解密是否成功（检查 TS 同步字节 0x47）
 */
function isDecryptedValid(data) {
  let syncCount = 0;
  const checkCount = Math.min(Math.floor(data.length / 188), 20);
  for (let i = 0; i < checkCount; i++) {
    if (data[i * 188] === 0x47) syncCount++;
  }
  return syncCount >= checkCount * 0.8; // 80% 的包有同步字节
}

// ==================== M3U8 解析 ====================

function parseM3U8(content) {
  const lines = content.split('\n');
  const result = {
    segments: [],
    key: null,
    iv: null,
    version: null,
    targetDuration: null,
    mediaSequence: null,
    endList: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = parseInt(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = parseFloat(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = parseInt(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      // 解析 KEY 属性
      const attrs = {};
      const attrStr = line.substring('#EXT-X-KEY:'.length);
      const re = /([A-Z-]+)=("([^"]*)"|([^,]*))/g;
      let match;
      while ((match = re.exec(attrStr)) !== null) {
        attrs[match[1]] = match[3] || match[4];
      }
      result.key = {
        method: attrs.METHOD,
        uri: attrs.URI,
        iv: attrs.IV || null,
      };
    } else if (line.startsWith('#EXTINF:')) {
      const duration = parseFloat(line.split(':')[1].split(',')[0]);
      i++;
      if (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('#')) {
        result.segments.push({
          duration,
          url: lines[i].trim(),
        });
      }
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      result.endList = true;
    }
  }

  return result;
}

// ==================== HTTP 请求工具 ====================

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://acpcssr.47u3j9k8.work',
  'Referer': 'https://acpcssr.47u3j9k8.work/',
};

async function fetchWithHeaders(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...BROWSER_HEADERS,
      ...(options.headers || {}),
    },
  });
}

// ==================== 主下载流程 ====================

async function downloadAndDecrypt(m3u8Url, videoInfo, outputDir) {
  console.log(`\n📋 正在下载 M3U8: ${m3u8Url}`);
  
  const response = await fetchWithHeaders(m3u8Url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const m3u8Content = await response.text();
  const playlist = parseM3U8(m3u8Content);
  
  console.log(`📋 解析结果:`);
  console.log(`   版本: ${playlist.version}`);
  console.log(`   片段数: ${playlist.segments.length}`);
  console.log(`   加密: ${playlist.key ? `${playlist.key.method} (${playlist.key.uri})` : '无'}`);
  console.log(`   结束标记: ${playlist.endList ? '是' : '否（直播流）'}`);

  if (!playlist.endList) {
    console.log('⚠️ 这是一个直播流，可能无法完整下载');
  }

  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  // 下载第一个片段用于密钥测试
  const firstSegUrl = playlist.segments[0].url.startsWith('http') 
    ? playlist.segments[0].url 
    : baseUrl + playlist.segments[0].url;
  
  console.log(`\n🔬 下载第一个片段测试密钥...`);
  const firstSegRes = await fetchWithHeaders(firstSegUrl);
  const firstSegData = Buffer.from(await firstSegRes.arrayBuffer());
  
  console.log(`   大小: ${firstSegData.length} 字节`);

  // 尝试所有密钥推导方法
  let foundKey = null;
  let foundIv = Buffer.alloc(16, 0); // 默认全零 IV

  if (playlist.key && playlist.key.method === 'AES-128') {
    console.log(`\n🔑 尝试解密密钥推导...`);
    
    // 构建候选密钥列表
    const candidates = [];
    
    // 固定密钥
    for (const k of COMMON_KEYS) {
      candidates.push({ name: `固定密钥: ${k.toString('hex').substring(0, 16)}...`, key: k });
    }

    // checksum 推导
    if (videoInfo?.checkSum) {
      const ck = deriveKeyFromCheckSum(videoInfo.checkSum);
      if (ck) candidates.push({ name: `CheckSum (hex): ${videoInfo.checkSum}`, key: ck });
      
      // checksum 作为字符串的 MD5
      candidates.push({ 
        name: `MD5(CheckSum): ${videoInfo.checkSum}`, 
        key: deriveKeyFromMD5(videoInfo.checkSum) 
      });
    }

    // 文件名推导
    const m3u8Filename = m3u8Url.split('/').pop().replace('.m3u8', '');
    candidates.push({ name: `MD5(文件名): ${m3u8Filename}`, key: deriveKeyFromMD5(m3u8Filename) });
    
    // 完整路径推导
    const m3u8Path = m3u8Url.replace(/^https?:\/\//, '');
    candidates.push({ name: `MD5(路径): ${m3u8Path}`, key: deriveKeyFromMD5(m3u8Path) });

    // 视频 ID 推导
    const videoId = videoInfo?.videoId || m3u8Filename;
    candidates.push({ name: `MD5(视频ID): ${videoId}`, key: deriveKeyFromMD5(String(videoId)) });

    // 测试每个候选密钥
    for (const { name, key } of candidates) {
      try {
        const decrypted = aes128cbcDecrypt(firstSegData, key, foundIv);
        if (isDecryptedValid(decrypted)) {
          console.log(`   ✅ 找到密钥! 方法: ${name}`);
          console.log(`   密钥: ${key.toString('hex')}`);
          foundKey = key;
          break;
        }
      } catch (e) {
        // 解密失败，继续下一个
      }
    }

    if (!foundKey) {
      console.log(`\n❌ 未能推导出解密密钥！`);
      console.log(`   已尝试 ${candidates.length} 种方法`);
      console.log(`\n💡 建议: 使用浏览器捕获方案 (video-capture.js 或 download-cli.js 的 Playwright 模式)`);
      
      // 仍然下载加密的 TS 文件
      console.log(`\n📥 将下载加密的 TS 片段（可用 ffmpeg 配合密钥解密）...`);
      return await downloadSegmentsOnly(playlist, baseUrl, outputDir, null, null);
    }
  } else {
    // 无加密，直接下载
    console.log(`\n✅ 视频未加密，直接下载 TS 片段...`);
  }

  // 下载并解密所有片段
  console.log(`\n📥 下载并解密 ${playlist.segments.length} 个片段...`);
  
  const tsDir = path.join(outputDir, 'ts_segments');
  fs.mkdirSync(tsDir, { recursive: true });

  const decryptedSegments = [];
  
  for (let i = 0; i < playlist.segments.length; i++) {
    const seg = playlist.segments[i];
    const segUrl = seg.url.startsWith('http') ? seg.url : baseUrl + seg.url;
    
    process.stdout.write(`\r⬇️ 片段 ${i + 1}/${playlist.segments.length} [${Math.round((i + 1) / playlist.segments.length * 100)}%]`);
    
    const segRes = await fetchWithHeaders(segUrl);
    let segData = Buffer.from(await segRes.arrayBuffer());
    
    if (foundKey) {
      try {
        // HLS 规范：如果 m3u8 中指定了 IV，使用指定的 IV
        // 否则使用序列号作为 IV（大端序）
        let segIv;
        if (playlist.key?.iv) {
          segIv = Buffer.from(playlist.key.iv.replace('0x', ''), 'hex');
        } else {
          segIv = Buffer.alloc(16, 0);
          const seqNum = (playlist.mediaSequence || 0) + i;
          segIv.writeUInt32BE(seqNum, 12);
        }
        
        segData = aes128cbcDecrypt(segData, foundKey, segIv);
      } catch (e) {
        console.log(`\n⚠️ 片段 ${i} 解密失败: ${e.message}`);
      }
    }
    
    decryptedSegments.push(segData);
  }
  
  console.log(`\n✅ 下载完成！`);

  // 合并所有片段
  console.log(`🔗 合并为 MP4 文件...`);
  const mergedPath = path.join(outputDir, 'output.ts');
  const mergedBuffer = Buffer.concat(decryptedSegments);
  fs.writeFileSync(mergedPath, mergedBuffer);
  
  const sizeMB = (mergedBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`✅ 合并完成!`);
  console.log(`📁 文件: ${mergedPath}`);
  console.log(`📦 大小: ${sizeMB} MB`);
  
  return mergedPath;
}

async function downloadSegmentsOnly(playlist, baseUrl, outputDir) {
  const tsDir = path.join(outputDir, 'ts_segments');
  fs.mkdirSync(tsDir, { recursive: true });

  for (let i = 0; i < playlist.segments.length; i++) {
    const seg = playlist.segments[i];
    const segUrl = seg.url.startsWith('http') ? seg.url : baseUrl + seg.url;
    
    process.stdout.write(`\r⬇️ 加密片段 ${i + 1}/${playlist.segments.length}`);
    
    const segRes = await fetchWithHeaders(segUrl);
    const segData = Buffer.from(await segRes.arrayBuffer());
    fs.writeFileSync(path.join(tsDir, seg.url.split('/').pop()), segData);
  }

  // 创建合并文件
  const mergedPath = path.join(outputDir, 'encrypted_merged.ts');
  const mergedStream = fs.createWriteStream(mergedPath);
  for (const seg of playlist.segments) {
    const segPath = path.join(tsDir, seg.url.split('/').pop());
    if (fs.existsSync(segPath)) {
      mergedStream.write(fs.readFileSync(segPath));
    }
  }
  mergedStream.end();
  
  console.log(`\n✅ 加密 TS 下载完成: ${mergedPath}`);
  return mergedPath;
}

// ==================== CLI ====================
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('用法: node m3u8-downloader.js <m3u8或页面URL> [checksum] [输出目录]');
    console.log('示例: node m3u8-downloader.js "https://xxx.com/video.m3u8" "0d9fe803..." ./output');
    process.exit(1);
  }

  const url = args[0];
  const checkSum = args[1] || null;
  const outputDir = args[2] || path.join(__dirname, 'downloads');
  
  fs.mkdirSync(outputDir, { recursive: true });

  let m3u8Url = url;
  let videoInfo = { checkSum };

  // 如果是页面 URL，尝试提取视频信息
  if (url.includes('/play/') || url.includes('/anime/')) {
    console.log('🔍 检测到页面URL，正在提取视频信息...');
    try {
      const pageRes = await fetchWithHeaders(url);
      const html = await pageRes.text();
      
      // 提取 __NUXT__ 数据
      const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*({.*?});/s);
      if (nuxtMatch) {
        // 提取 playPath
        const ppMatch = nuxtMatch[1].match(/"playPath"\s*:\s*"([^"]+)"/);
        if (ppMatch) {
          m3u8Url = ppMatch[1];
          console.log(`✅ 找到 M3U8: ${m3u8Url}`);
        }
        
        // 提取 checkSum
        if (!checkSum) {
          const csMatch = nuxtMatch[1].match(/"checkSum"\s*:\s*"([^"]+)"/);
          if (csMatch) {
            videoInfo.checkSum = csMatch[1];
            console.log(`✅ 找到 CheckSum: ${videoInfo.checkSum}`);
          }
        }
        
        // 提取标题
        const titleMatch = nuxtMatch[1].match(/"title"\s*:\s*"([^"]+)"/);
        if (titleMatch) {
          videoInfo.title = titleMatch[1];
          console.log(`📹 标题: ${videoInfo.title}`);
        }
      }
    } catch (e) {
      console.log(`⚠️ 提取失败: ${e.message}`);
    }
  }

  await downloadAndDecrypt(m3u8Url, videoInfo, outputDir);
}

main().catch(console.error);

export { downloadAndDecrypt, parseM3U8, aes128cbcDecrypt, deriveKeyFromCheckSum, deriveKeyFromMD5 };
