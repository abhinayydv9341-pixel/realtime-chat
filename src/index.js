'use strict';

const { createServer } = require('./server');

async function main() {
  const server = await createServer();
  const port = await server.listen();
  console.log(`chat server ${server.config.instanceId} listening on :${port}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
