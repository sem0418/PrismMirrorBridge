import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export function viaProxy(port, url, { ca, method = 'GET', headers = {}, body, timeout = 60000, maxBytes = 48 * 1024 * 1024 } = {}) {
  const u = new URL(url);
  const agent = new https.Agent({ keepAlive: false });
  let peer;
  agent.createConnection = (_options, callback) => {
    const connect = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: u.hostname + ':443', agent: false });
    connect.setTimeout(timeout, () => connect.destroy(new Error('CONNECT timed out')));
    connect.once('error', callback);
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); callback(new Error('CONNECT returned ' + response.statusCode)); return; }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: u.hostname, ca, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' });
      secure.once('error', error => callback(error));
      secure.once('secureConnect', () => { peer = secure.getPeerCertificate(); callback(null, secure); });
    }); connect.end();
  };
  return new Promise((resolve, reject) => {
    const request = https.request(u, { agent, method, headers }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) response.destroy(new Error('Response exceeds test limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), peer }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Request timed out')));
    request.once('error', reject);
    if (body) request.write(body); request.end();
  }).finally(() => agent.destroy());
}
