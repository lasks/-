/**
 * AcFan 视频下载器 v2 - 多层拦截
 *   crypto.subtle.decrypt + MediaSource + fetch
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INIT = `
(function(){
window.__vd=[];window.__on=true;window.__keys=[];
var oa=MediaSource.prototype.addSourceBuffer;
MediaSource.prototype.addSourceBuffer=function(t){
  var s=oa.call(this,t);
  if(!s.__h){s.__h=true;var aa=s.appendBuffer.bind(s);
  s.appendBuffer=function(b){if(window.__on)window.__vd.push(new Uint8Array(b));aa(b)}}
  return s};
if(typeof ManagedMediaSource!=='undefined'){
  var om=ManagedMediaSource.prototype.addSourceBuffer;
  ManagedMediaSource.prototype.addSourceBuffer=function(t){
    var s=om.call(this,t);
    if(!s.__h){s.__h=true;var aa=s.appendBuffer.bind(s);
    s.appendBuffer=function(b){if(window.__on)window.__vd.push(new Uint8Array(b));aa(b)}}
    return s}}
try{
var ds=SubtleCrypto.prototype.decrypt;
SubtleCrypto.prototype.decrypt=async function(a,k,d){
  var r=await ds.call(this,a,k,d);
  if(window.__on&&a.name==='AES-CBC'){
    var dd=new Uint8Array(r);
    if(dd[0]===0x47||dd.length>1e5){
      console.log('[Crypto] captured',dd.length,'bytes');
      window.__vd.push(dd)}}return r};
var ik=SubtleCrypto.prototype.importKey;
SubtleCrypto.prototype.importKey=async function(f,kd,a,e,u){
  if(f==='raw'&&a.name==='AES-CBC'&&u.includes('decrypt')){
    var kb=new Uint8Array(kd);var h=Array.from(kb).map(b=>b.toString(16).padStart(2,'0')).join('');
    console.log('[Crypto] KEY:',h);window.__keys.push(h);window.__lk=h}
  return ik.call(this,f,kd,a,e,u)}}catch(e){}
var of=window.fetch;
window.fetch=async function(u,o){
  var us=typeof u==='string'?u:u.url;
  if(us&&us.includes('enc.key')){
    var r=await of.apply(this,arguments);
    try{var b=await r.clone().arrayBuffer();var kb=new Uint8Array(b);
    var h=Array.from(kb).map(b=>b.toString(16).padStart(2,'0')).join('');
    console.log('[Fetch] key:',h);window.__keys.push(h);window.__lk=h}catch(e){}return r}
  return of.apply(this,arguments)};
console.log('[Capture] injected')})();`;

const GET_INFO = `
(()=>{
var n=window.__NUXT__;if(!n)return null;
for(var k of Object.keys(n.data||{})){
var d=n.data[k]?.data||n.data[k];
if(d?.playPath&&d?.title)return{title:d.title,playPath:d.playPath,checkSum:d.checkSum,playTime:d.playTime,size:d.size}}
return null})()`;

async function download(url, outDir) {
  console.log('🎬 AcFan Downloader v2\n📌 ' + url);
  outDir = outDir || path.join(__dirname, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();

  let logs = [];
  page.on('console', m => {
    var t = m.text();
    if (t.includes('[Hook]') || t.includes('[Crypto]') || t.includes('[Capture]') || t.includes('[Fetch]')) {
      logs.push(t); console.log('  ' + t);
    }
  });
  page.on('response', async r => {
    if (r.url().includes('.m3u8') && r.status() === 200) {
      try { var b = await r.text(); if (b.includes('#EXTM3U')) fs.writeFileSync(path.join(outDir, 'playlist.m3u8'), b); } catch (e) { }
    }
  });

  try {
    console.log('⏳ 加载...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    var info = await page.evaluate(GET_INFO);
    if (info) console.log('📹 ' + info.title + ' | ⏱️ ' + Math.round(info.playTime / 60) + 'min | 📦 ' + (info.size / 1048576).toFixed(0) + 'MB');

    await page.waitForSelector('video', { timeout: 15000 }).catch(() => { });
    await page.evaluate(() => { document.querySelectorAll('[class*="close"], [class*="Close"], [class*="skip"], .xgplayer-enter').forEach(e => e.click()); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { var v = document.querySelector('video'); var b = document.querySelector('.xgplayer-play, .xgplayer-start'); if (b) b.click(); if (v) { v.muted = true; v.play().catch(() => { }); } });
    console.log('▶️ 捕获中...\n');

    var start = Date.now(), lastN = 0;
    var dur = await page.evaluate(() => document.querySelector('video')?.duration || 0);

    var iv = setInterval(async () => {
      var s = await page.evaluate(() => {
        var v = document.querySelector('video'); var d = window.__vd || [];
        return { n: d.length, mb: (d.reduce((s, c) => s + c.length, 0) / 1048576).toFixed(2), t: v?.currentTime || 0, dur: v?.duration || 0, end: v?.ended, key: window.__lk };
      });
      var el = Math.round((Date.now() - start) / 1000);
      var pct = s.dur > 0 ? Math.round(s.t / s.dur * 100) : '?';
      if (s.n > lastN || el % 10 === 0) {
        console.log('  [' + el + 's] ' + Math.round(s.t) + 's/' + Math.round(s.dur) + 's (' + pct + '%) | 📦 ' + s.mb + ' MB (' + s.n + ' chunks)' + (s.key ? ' 🔑' : ''));
        lastN = s.n;
      }
    }, 5000);

    var maxWait = Math.max(dur * 1500, 900000); // 15 min max
    try { await page.waitForFunction(() => document.querySelector('video')?.ended, { timeout: maxWait }); console.log('✅ 播放完成'); }
    catch { console.log('⚠️ 超时停止'); }
    clearInterval(iv);
    await page.waitForTimeout(2000);

    console.log('\n📦 导出...');
    var res = await page.evaluate(() => {
      window.__on = false;
      var d = window.__vd || [];
      if (!d.length) return null;
      var tl = d.reduce((s, c) => s + c.length, 0);
      var m = new Uint8Array(tl); var o = 0;
      for (var c of d) { m.set(c, o); o += c.length; }
      var bin = '';
      for (var i = 0; i < m.length; i++) bin += String.fromCharCode(m[i]);
      return { size: tl, n: d.length, key: window.__lk, b64: btoa(bin) };
    });

    if (!res || !res.size) {
      console.log('\n❌ 无数据!');
      console.log('日志 (最后20条):'); logs.slice(-20).forEach(l => console.log('  ' + l));
      console.log('\n💡 playlist.m3u8 已保存到 ' + outDir);
      return null;
    }

    var fn = (info?.title || 'video').replace(/[<>:"/\\|?*]/g, '_').trim();
    var fp = path.join(outDir, fn + '.mp4');
    fs.writeFileSync(fp, Buffer.from(res.b64, 'base64'));
    console.log('\n✅ 完成! 📁 ' + fp + '\n📦 ' + (res.size / 1048576).toFixed(2) + ' MB');
    if (res.key) console.log('🔑 密钥: ' + res.key);
    return fp;
  } catch (e) { console.error('❌ ' + e.message); throw e; }
  finally { await browser.close(); console.log('🔒 关闭'); }
}

var url = process.argv[2];
if (!url) { console.log('用法: node download.js <URL> [输出目录]'); process.exit(1); }
download(url, process.argv[3]).catch(console.error);
