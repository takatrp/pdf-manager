import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createServer } from 'node:http';

const rootDir = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
};

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host}`);
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relativePath = pathname.replace(/^\/pdf-manager(?:\/|$)/, '/');
    let filePath = resolve(rootDir, `.${relativePath}`);

    if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`PDF Manager test server listening on http://127.0.0.1:${port}`);
});
