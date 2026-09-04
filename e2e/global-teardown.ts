import net from 'node:net';
import path from 'node:path';

export default async function globalTeardown() {
  const socketPath = path.join(
    process.cwd(),
    'test-results',
    'native-runtime',
    'native.sock',
  );
  await new Promise<void>((resolve) => {
    const client = net.createConnection(socketPath);
    const done = () => {
      client.destroy();
      resolve();
    };
    client.setTimeout(2_000, done);
    client.once('error', done);
    client.once('data', done);
    client.once('connect', () => {
      client.write(`${JSON.stringify({ op: 'stop', force: true })}\n`);
    });
  });
}
