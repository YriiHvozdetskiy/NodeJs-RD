import net from 'node:net';

const PORT = 3000;
const REASON = {200: 'OK', 304: 'Not Modified', 404: 'Not Found'};

export function parseRequest(buf) {
   const headerEnd = buf.indexOf('\r\n\r\n');
   if (headerEnd === -1) return null;
   const [requestLine, ...headerLines] = buf.slice(0, headerEnd).split('\r\n');
   const [method, path, httpVersion] = requestLine.split(' ');
   const headers = Object.fromEntries(
      headerLines.map((line) => {
         const i = line.indexOf(':');
         return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
      }),
   );
   return {method, path, httpVersion, headers};
}

export function handle(req) {
   if (req.path === '/') {
      return {status: 200, type: 'text/plain; charset=utf-8', body: 'сирий net — привіт\n'};
   }
   if (req.path === '/headers') {
      const dump = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
      return {status: 200, type: 'text/plain; charset=utf-8', body: dump + '\n'};
   }
   return {status: 404, type: 'text/plain; charset=utf-8', body: 'не знайдено\n'};
}

export function serialize({status, type, body}, {keepAlive = false} = {}) {
   return (
      `HTTP/1.1 ${status} ${REASON[status]}\r\n` +
      `Content-Type: ${type}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n` +
      '\r\n' +
      body
   );
}

export function onConnection(socket) {
   let buf = '';
   socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const req = parseRequest(buf);
      if (!req) return;

      const out = handle(req);
      console.log(`${req.method} ${req.path} → ${out.status}`);
      socket.write(serialize(out));

      socket.end()
   });

   socket.on('error', (e) => console.log(`сокет: ${e.code}`));
}

if (import.meta.main) {
   net.createServer(onConnection).listen(PORT, () => console.log(`run on:${PORT}`))
}
