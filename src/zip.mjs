import { inflateRawSync } from 'node:zlib';
// Read selected JSON entries from an installer JAR without extracting any paths.
export function zipJSON(buffer, filename) {
  let end = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { end = p; break; }
  }
  if (end < 0) throw new Error('Invalid installer ZIP');
  const count = buffer.readUInt16LE(end + 10); let pos = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10), size = buffer.readUInt32LE(pos + 20),
      unpacked = buffer.readUInt32LE(pos + 24), nameLength = buffer.readUInt16LE(pos + 28), extraLength = buffer.readUInt16LE(pos + 30),
      commentLength = buffer.readUInt16LE(pos + 32), local = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (name === filename) {
      if (flags & 1 || unpacked > 8 * 1024 * 1024 || ![0, 8].includes(method)) throw new Error('Unsupported installer ZIP entry');
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP entry');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      if (start + size > buffer.length) throw new Error('Truncated ZIP entry');
      const data = buffer.subarray(start, start + size);
      const raw = method === 8 ? inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 }) : data;
      if (raw.length !== unpacked) throw new Error('ZIP size mismatch');
      return JSON.parse(raw.toString('utf8'));
    }
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}
