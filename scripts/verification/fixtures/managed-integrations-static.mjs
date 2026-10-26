import { deflateSync } from 'node:zlib';

// Real, deterministic document bytes; no renderer or extraction API substitutes.
export function staticFixtures() {
  const stream = 'BT /F1 18 Tf 72 720 Td (Private static PDF qualification text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([len, name, data, crc]); };
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])), chunk('IDAT', deflateSync(Buffer.from([0,40,120,200,255]))), chunk('IEND', Buffer.alloc(0))]);
  const html = '<!doctype html><html><head><title>Canvas fallback article</title></head><body><article><h1>Canvas fallback article</h1><canvas>Accessible canvas fallback text.</canvas>' + Array.from({length: 12}, (_, i) => `<p>Qualification paragraph ${i}. This private static article contains meaningful text about safe deterministic extraction without an optional canvas package. The article must remain readable through the real HTML extraction pipeline.</p>`).join('') + '</article></body></html>';
  return new Map([['https://fixture.example/article', ['text/html', html]], ['https://fixture.example/static.pdf', ['application/pdf', Buffer.from(pdf)]], ['https://fixture.example/static.png', ['image/png', png]]]);
}
