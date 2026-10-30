import { connectRemote } from './ssh.mjs';
// Fixed read-only Linux commands; no user-supplied text is interpolated into the shell.
const script = `set -eu
export LC_ALL=C
test -r /proc/stat && test -r /proc/meminfo || { echo LINUX_REQUIRED >&2; exit 42; }
before=$(awk '/^cpu /{t=0;for(i=2;i<=9;i++)t+=$i;print t,$5+$6;exit}' /proc/stat)
sleep 0.25
after=$(awk '/^cpu /{t=0;for(i=2;i<=9;i++)t+=$i;print t,$5+$6;exit}' /proc/stat)
awk -v a="$before" -v b="$after" 'BEGIN{split(a,x," ");split(b,y," ");d=y[1]-x[1];u=d>0?(1-(y[2]-x[2])/d)*100:0;printf "CPU\\t%.2f\\n",u}'
awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2;found=1}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{if(!found)a=f+b+c;printf "MEM\\t%.0f\\t%.0f\\t%.0f\\t%.0f\\n",t,a,st,sf}' /proc/meminfo
printf 'UPTIME\\t'; cut -d' ' -f1 /proc/uptime
printf 'LOAD\\t'; cat /proc/loadavg
printf 'CORES\\t'; getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1
printf 'HOST\\t'; uname -n
df -Pk -x tmpfs -x devtmpfs | awk 'NR>1{m=$6;for(i=7;i<=NF;i++)m=m" "$i;printf "DISK\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n",$1,$2,$3,$4,$5,m}'
`;
export async function readMetrics(server, secrets) {
  const remote = await connectRemote(server, secrets);
  try {
    const output = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        remote.end();
        reject(new Error('监控读取超时'));
      }, 10000);
      let stdout = '',
        stderr = '',
        settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      remote.once('error', fail);
      remote.exec('LC_ALL=C sh -s', (error, channel) => {
        if (error) return fail(error);
        channel.on('data', (data) => {
          stdout += data.toString();
          if (stdout.length > 131072) {
            channel.close();
            fail(new Error('监控输出超过限制'));
          }
        });
        channel.stderr.on('data', (data) => {
          if (stderr.length < 2048) stderr += data.toString();
        });
        channel.on('error', fail);
        channel.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (code !== 0)
            reject(
              new Error(
                code === 42 || stderr.includes('LINUX_REQUIRED')
                  ? '当前监控支持 Linux，需要 /proc 与 df'
                  : '无法读取监控，请检查 SSH 账号的系统读取权限',
              ),
            );
          else resolve(stdout);
        });
        channel.end(script);
      });
    });
    const result = {
      cpu: 0,
      memory: {},
      disks: [],
      load: [],
      sampledAt: new Date().toISOString(),
      hostname: server.host,
      cores: 1,
      uptime: 0,
    };
    for (const line of output.split('\n')) {
      const [type, ...data] = line.split('\t');
      if (type === 'CPU') result.cpu = Math.max(0, Math.min(100, Number(data[0])));
      if (type === 'MEM') {
        const [total, available, swapTotal, swapFree] = data.map((v) => Number(v) * 1024);
        result.memory = {
          total,
          available,
          used: total - available,
          percent: total > 0 ? ((total - available) / total) * 100 : 0,
          swapTotal,
          swapUsed: swapTotal - swapFree,
        };
      }
      if (type === 'DISK') {
        const [device, total, used, available, percent, mount] = data;
        result.disks.push({
          device,
          mount,
          total: Number(total) * 1024,
          used: Number(used) * 1024,
          available: Number(available) * 1024,
          percent: Number(percent.replace('%', '')),
        });
      }
      if (type === 'LOAD') result.load = data.join(' ').split(/\s+/).slice(0, 3).map(Number);
      if (type === 'CORES') result.cores = Number(data[0]) || 1;
      if (type === 'HOST') result.hostname = data[0];
      if (type === 'UPTIME') result.uptime = Number(data[0]);
    }
    if (!result.memory.total || !Number.isFinite(result.cpu))
      throw new Error('未取得有效 Linux 监控指标');
    return result;
  } finally {
    remote.end();
  }
}
