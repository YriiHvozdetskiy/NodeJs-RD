import net from 'node:net';

const PORT = 3000;
const REASON = {
   200: 'OK',
   304: 'Not Modified',
   404: 'Not Found',
   431: 'Request Header Fields Too Large',
};

// Стеля на блок заголовків. Без неї клієнт, який відкрив зʼєднання і шле байти,
// не надсилаючи `\r\n\r\n`, роздуває buf безкінечно — одного сокета вистачає,
// щоб зʼїсти памʼять процесу. 8 КБ — та сама межа, що за замовчуванням у nginx.
const MAX_HEADER_BYTES = 8192;

// Приймає Buffer, а не рядок: кадрування HTTP байт-орієнтоване, тому межу
// шукаємо по байтах. UTF-8 декодуємо один раз — уже на вирізаному блоці
// заголовків, коли його межі відомі точно.
export function parseRequest(buf) {
   const headerEnd = buf.indexOf('\r\n\r\n'); // Buffer.indexOf — байтовий зсув
   if (headerEnd === -1) return null;         // заголовки ще не всі — чекаємо далі

   const block = buf.subarray(0, headerEnd).toString('utf8');
   const [requestLine, ...headerLines] = block.split('\r\n');
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
   let buf = Buffer.alloc(0);
   let closing = false;

   socket.on('data', (chunk) => {
      if (closing) return; // відповідь уже пішла — більше нічого не накопичуємо
      buf = Buffer.concat([buf, chunk]); // накопичуємо байти, а не символи

      const req = parseRequest(buf);
      if (!req) {
         // Заголовки ще не всі — але чи не забагато їх уже?
         if (buf.length > MAX_HEADER_BYTES) {
            closing = true;
            console.log(`  ${buf.length} Б без \\r\\n\\r\\n → 431, рву зʼєднання`);
            const out = {status: 431, type: 'text/plain; charset=utf-8', body: 'заголовки завеликі\n'};
            // destroy у колбеку: спершу відповідь долітає, потім рвемо сокет,
            // інакше клієнт міг би слати далі й далі роздувати памʼять.
            socket.end(serialize(out), () => socket.destroy());
         }
         return;
      }

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
