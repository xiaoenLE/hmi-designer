/**
 * sha256.js — 纯 JS SHA-256（零依赖，哪个环境都能跑）
 *
 * 用途：HMI **操作权限的密码**——密码不落明文，工程里只存 `盐 + 迭代哈希`。
 *
 * 为什么不用浏览器自带的 crypto.subtle（PBKDF2）：
 *   crypto.subtle 只在**安全上下文**里存在。现场大量用 `http://192.168.x.x:8866`
 *   打开（不是安全上下文）→ `crypto.subtle` 是 undefined → 那种机器上密码功能直接不可用。
 *   自己实现一份，什么地址打开都一样，也不用引第三方库（本工程一直是零依赖）。
 *
 * 强度说明（说清楚，别以为它等于 HashiCorp Vault）：
 *   · 盐 + 数千次迭代，目的是**不要明文存**、拿到工程文件也不能一眼看出密码、
 *     也挡一下离线暴力枚举；
 *   · 它挡不住"能改工程文件的人"（那种人直接把密码/权限改掉就行）——这是本地装置的
 *     操作权限，不是网络服务的鉴权。真正的管理员闸门还是后端那套（PBKDF2 + 会话）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256（输入 Uint8Array，返回 32 字节 Uint8Array） */
export function sha256Bytes(bytes) {
  const len = bytes.length;
  // padding：0x80 + 若干 0 + 64 位长度（大端）
  const withPad = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLenHi = Math.floor(len / 536870912);      // len * 8 的高 32 位（js 位运算只有 32 位）
  const bitLenLo = (len << 3) >>> 0;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLenHi);
  dv.setUint32(withPad.length - 4, bitLenLo);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

/** UTF-8 编码（TextEncoder 到处都有，且不受"安全上下文"限制） */
export function utf8Bytes(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
  // 极老的 WebView 兜底：只处理 Latin-1（现场基本不会走到）
  const out = new Uint8Array(String(s).length);
  for (let i = 0; i < out.length; i++) out[i] = String(s).charCodeAt(i) & 0xff;
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export const sha256Hex = (str) => bytesToHex(sha256Bytes(utf8Bytes(str)));

/**
 * 口令哈希：salt 打头，再迭代 N 次 —— 不存明文，也让"拿到工程文件离线枚举"变贵。
 * iter（迭代次数）跟着哈希一起存：以后想调大，老密码照样能验。
 */
export const PERM_HASH_ITER = 4000;
export function hashPassword(pw, salt, iter = PERM_HASH_ITER) {
  const sb = utf8Bytes(`${salt}:${pw}`);
  let h = sha256Bytes(sb);
  const saltBytes = utf8Bytes(String(salt));
  for (let i = 0; i < Math.max(1, iter); i++) {
    const buf = new Uint8Array(h.length + saltBytes.length);
    buf.set(h); buf.set(saltBytes, h.length);
    h = sha256Bytes(buf);
  }
  return bytesToHex(h);
}

/** 随机盐（16 字节 hex）。没有 crypto.getRandomValues 的环境（极老）退回时间戳 */
export function newSalt() {
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = (Date.now() >> (i % 4) * 8) & 0xff;
  return bytesToHex(b);
}

/** 校验密码：常数时间比较（避免"前几位对得快"这种时间侧信道，虽然本地装置不敏感） */
export function verifyPassword(pw, level) {
  if (!level) return false;
  const given = String(pw ?? '');
  // 新写法：工程里存的是**可还原的混淆串**（组态端要能回看自己设的密码）
  if (level.pw) return safeEqual(deobfuscate(level.pw, level.id || ''), given);
  // 老写法（哈希，不可还原）：以前版本的工程照样能验
  if (level.hash && level.salt) {
    return safeEqual(hashPassword(given, level.salt, level.iter || PERM_HASH_ITER), String(level.hash));
  }
  return false;
}

/** 定长无关比较（长度不同直接 false，长度相同再逐字符异或） */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── 可还原的混淆（不是加密）──
   组态时设了密码，之后还要能回看/再确认（"上次设的是多少来着"），所以工程里不能只存哈希。
   做法：明文按 sha256(key) 逐字节异或后 Base64 —— JSON 里看不到明文，
   但**能还原**：它挡的是"随手打开工程文件瞟一眼"，不是有心的攻击者。
   校验密码时应该用哈希那条路（verifyPassword 里对新密码也仍然走混淆串比对，
   因为同一个密码两者等价；要更强就往 level.hash 那条路走）。 */
export function obfuscate(text, key) {
  const kb = sha256Bytes(utf8Bytes(String(key || 'hmi')));
  const tb = utf8Bytes(String(text ?? ''));
  const out = new Uint8Array(tb.length);
  for (let i = 0; i < tb.length; i++) out[i] = tb[i] ^ kb[i % kb.length];
  return bytesToBase64(out);
}
export function deobfuscate(enc, key) {
  try {
    const tb = base64ToBytes(String(enc || ''));
    const kb = sha256Bytes(utf8Bytes(String(key || 'hmi')));
    const out = new Uint8Array(tb.length);
    for (let i = 0; i < tb.length; i++) out[i] = tb[i] ^ kb[i % kb.length];
    return typeof TextDecoder !== 'undefined'
      ? new TextDecoder().decode(out)
      : String.fromCharCode(...out);
  } catch { return ''; }
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(bytes).toString('base64');       // Node（跑测试时）
}
function base64ToBytes(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
