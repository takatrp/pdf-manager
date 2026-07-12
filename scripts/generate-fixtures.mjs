import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = resolve(rootDir, 'tests/fixtures');
await mkdir(fixturesDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function createPng(width, height, pixelFor) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelFor(x, y);
      const offset = 1 + x * 3;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function createPageFixture(fileName, pageCount, title, displayTitle = title, trailingMarker = '') {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('PDF Manager deterministic fixture generator');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = doc.addPage([420 + pageNumber * 20, 560 + pageNumber * 10]);
    page.drawRectangle({
      x: 24,
      y: 24,
      width: page.getWidth() - 48,
      height: page.getHeight() - 48,
      color: rgb(0.12 * pageNumber, 0.18, 0.28),
    });
    page.drawText(`${displayTitle} - page ${pageNumber}`, {
      x: 48,
      y: page.getHeight() - 90,
      size: 22,
      font,
      color: rgb(1, 1, 1),
    });
  }

  const pdfBytes = Buffer.from(await doc.save());
  const markerBytes = trailingMarker ? Buffer.from(`\n% ${trailingMarker}\n`, 'utf8') : Buffer.alloc(0);
  await writeFile(resolve(fixturesDir, fileName), Buffer.concat([pdfBytes, markerBytes]));
}

await createPageFixture('simple-2pages.pdf', 2, 'Two-page fixture');
await createPageFixture(
  'simple-3pages.pdf',
  3,
  'Three-page fixture',
  'Three-page fixture',
  'PDF_MANAGER_PRIVATE_FIXTURE_SENTINEL',
);
await createPageFixture('japanese-text.pdf', 2, '日本語テスト文書', 'Japanese text fixture');

const samplePng = createPng(64, 48, (x, y) => [
  (x * 4) % 256,
  (y * 5) % 256,
  ((x + y) * 3) % 256,
]);
await writeFile(resolve(fixturesDir, 'sample.png'), samplePng);

const sampleJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
  'base64',
);
await writeFile(resolve(fixturesDir, 'sample.jpg'), sampleJpeg);

const noisyPng = createPng(512, 512, (x, y) => {
  const value = (x * 1103515245 + y * 12345 + x * y * 97) >>> 0;
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
});
const compressionDoc = await PDFDocument.create();
compressionDoc.setTitle('Compression fixture');
const noisyImage = await compressionDoc.embedPng(noisyPng);
for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
  const page = compressionDoc.addPage([512, 512]);
  page.drawImage(noisyImage, { x: 0, y: 0, width: 512, height: 512 });
}
await writeFile(resolve(fixturesDir, 'compression-source.pdf'), await compressionDoc.save());

console.log('Deterministic PDF, PNG, and JPEG fixtures generated.');
