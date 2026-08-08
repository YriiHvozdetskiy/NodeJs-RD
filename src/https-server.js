import tls from 'node:tls';
import {readFileSync} from 'node:fs';

import {onConnection} from './server.js';

const PORT = 3443;
const options = {key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem')};

tls.createServer(options, (socket) => {
   console.log(`TLS-сесія: ${socket.getProtocol()} ${socket.getCipher()?.name}`);
   onConnection(socket)
}).listen(PORT, () => console.log(`https on :${PORT}`));
