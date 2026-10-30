import { start } from '../server/index.mjs';
start().catch((error) => {
  console.error('启动失败：' + (error.code || error.message));
  process.exit(1);
});
