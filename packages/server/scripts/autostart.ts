import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.browser-mcp';
const HELP = `用法: pnpm autostart install [--dry-run] | status | uninstall

  install    生成当前用户的 macOS 登录自启配置并立即启动；重复执行更新配置
  --dry-run  仅校验并显示路径，不写文件、不启动或停止进程
  status     查看自启配置和 launchd 进程状态
  uninstall  停止 launchd 管理的服务并移除自启，保留日志

首次使用先运行 pnpm build。无需 sudo，仅支持 macOS。
install 保存当前 BRIDGE_* 环境变量；未提供的项保留上次配置，传空值可清除。
升级 Node 或移动仓库后重新 install，以更新绝对路径。`;
const ENV_KEYS = [
  'BRIDGE_HOST',
  'BRIDGE_PORT',
  'BRIDGE_TOKEN',
  'BRIDGE_ALLOWED_ORIGIN',
  'BRIDGE_REQUEST_TIMEOUT_MS',
  'BRIDGE_LOG',
  'BRIDGE_AUDIT',
  'BRIDGE_AUDIT_FILE',
] as const;

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败：${result.stderr.trim()}`);
  }
  return result.stdout;
}

function jobStatus(target: string): string | undefined {
  const result = spawnSync('/bin/launchctl', ['print', target], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  // 113 = 找不到服务；其他错误（例如权限不足）不能当成“未加载”。
  if (result.status === 113) return undefined;
  throw new Error(`无法查询 launchd：${result.stderr.trim()}`);
}

async function assertPortFree(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `端口 ${port} 已被占用。若是 bx 自动启动的服务，请先运行 BRIDGE_PORT=${port} bx daemon stop，再重试；脚本不会按端口杀进程。`,
            )
          : error,
      );
    });
    server.listen(port, host, () => server.close((error) => (error ? reject(error) : resolve())));
  });
}

async function main(): Promise<void> {
  const [command, ...options] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (
    !['install', 'status', 'uninstall'].includes(command) ||
    (options.length > 0 && !(command === 'install' && options.join(' ') === '--dry-run'))
  ) {
    throw new Error(HELP);
  }
  if (process.platform !== 'darwin') throw new Error('此命令仅支持 macOS。');
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('请以当前登录用户运行，不要使用 sudo。');

  const home = homedir();
  // 从脚本位置定位仓库，不能依赖调用者的 cwd，也不能把自己的用户名写进模板。
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const entry = join(root, 'packages/server/dist/index.js');
  const directory = join(home, 'Library/LaunchAgents');
  const plist = join(directory, `${LABEL}.plist`);
  const logs = join(home, '.browser-mcp');
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  const loaded = jobStatus(target);

  if (command === 'status') {
    console.log(`配置：${existsSync(plist) ? plist : '未安装'}`);
    // launchctl print 包含完整环境变量，不能把 BRIDGE_TOKEN 打到终端。
    console.log(`状态：${loaded?.match(/^\s*state = (.+)$/m)?.[1] ?? '未加载'}`);
    const pid = loaded?.match(/^\s*pid = (\d+)$/m)?.[1];
    if (pid) console.log(`PID：${pid}`);
    console.log(`日志：${join(logs, 'launchd.stderr.log')}`);
    return;
  }
  if (command === 'uninstall') {
    if (loaded) run('/bin/launchctl', ['bootout', target]);
    await rm(plist, { force: true });
    console.log('✓ 已停止 launchd 服务并移除登录自启，日志已保留。');
    return;
  }

  if (!existsSync(entry)) throw new Error('找不到服务构建产物，请先在仓库运行 pnpm build。');
  const previous = existsSync(plist) ? await readFile(plist, 'utf8') : undefined;
  const oldEnvironment: Record<string, unknown> = previous
    ? (JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], previous))
        .EnvironmentVariables ?? {})
    : {};
  const environment: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key] ?? oldEnvironment[key];
    if (typeof value === 'string' && value !== '') environment[key] = value;
  }
  const host = environment.BRIDGE_HOST ?? '127.0.0.1';
  const port = Number(environment.BRIDGE_PORT ?? 8777);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('BRIDGE_PORT 必须是 1–65535 的整数。');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !environment.BRIDGE_TOKEN) {
    throw new Error('非回环地址必须设置 BRIDGE_TOKEN。');
  }
  if (
    environment.BRIDGE_REQUEST_TIMEOUT_MS &&
    (!Number.isSafeInteger(Number(environment.BRIDGE_REQUEST_TIMEOUT_MS)) ||
      Number(environment.BRIDGE_REQUEST_TIMEOUT_MS) <= 0)
  ) {
    throw new Error('BRIDGE_REQUEST_TIMEOUT_MS 必须是正整数。');
  }
  if (environment.BRIDGE_AUDIT_FILE) {
    // 相对路径在交互式 shell 和 launchd 中可能指向不同文件，安装时固定下来。
    environment.BRIDGE_AUDIT_FILE = resolve(environment.BRIDGE_AUDIT_FILE);
  }
  // 用系统工具序列化，路径中的空格、&、引号无需手写 shell/XML 转义。
  const xml = run(
    '/usr/bin/plutil',
    ['-convert', 'xml1', '-o', '-', '-'],
    JSON.stringify({
      Label: LABEL,
      ProgramArguments: [process.execPath, entry],
      WorkingDirectory: root,
      EnvironmentVariables: environment,
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      StandardOutPath: join(logs, 'launchd.stdout.log'),
      StandardErrorPath: join(logs, 'launchd.stderr.log'),
    }),
  );
  console.log(`Node：${process.execPath}\n入口：${entry}\n配置：${plist}`);
  console.log(`保存的环境变量：${Object.keys(environment).join(', ') || '无（使用默认配置）'}`);
  if (options.includes('--dry-run')) {
    console.log('✓ 配置格式校验通过；未修改文件或进程。');
    return;
  }

  await mkdir(directory, { recursive: true });
  await mkdir(logs, { recursive: true });
  const temporary = `${plist}.${process.pid}.tmp`;
  let changed = false;
  try {
    // 先验证 GUI 会话存在，避免通过 SSH / sudo 在错误的会话中安装。
    run('/bin/launchctl', ['print', domain]);
    if (loaded) {
      run('/bin/launchctl', ['bootout', target]);
      changed = true;
      // bootout 返回时旧进程可能仍在关闭监听端口。
      for (let attempt = 0; ; attempt++) {
        try {
          await assertPortFree(host, port);
          break;
        } catch (error) {
          if (attempt >= 19) throw error;
          await sleep(250);
        }
      }
    } else {
      await assertPortFree(host, port);
    }
    // 配置可能含令牌：临时文件与最终文件都只允许当前用户读写。
    await writeFile(temporary, xml, { mode: 0o600, flag: 'wx' });
    await rename(temporary, plist);
    changed = true;
    run('/bin/launchctl', ['enable', target]);
    run('/bin/launchctl', ['bootstrap', domain, plist]);
    const checkHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const url = `http://${checkHost.includes(':') ? `[${checkHost}]` : checkHost}:${port}/healthz`;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500) });
        const body = (await response.json()) as { ok?: boolean };
        if (response.ok && body.ok && jobStatus(target)?.match(/^\s*pid = \d+$/m)) {
          console.log('✓ 已安装并启动；以后登录 macOS 自动启动，退出后自动恢复。');
          console.log(`日志：${join(logs, 'launchd.stderr.log')}`);
          return;
        }
      } catch {
        // 服务加载模块需要时间，先等健康检查，不能把 bootstrap 成功当成启动成功。
      }
      await sleep(250);
    }
    throw new Error(`服务未通过健康检查，请查看 ${join(logs, 'launchd.stderr.log')}`);
  } catch (error) {
    if (changed) {
      try {
        if (jobStatus(target)) run('/bin/launchctl', ['bootout', target]);
        if (previous !== undefined) {
          await writeFile(plist, previous, { mode: 0o600 });
          if (loaded) run('/bin/launchctl', ['bootstrap', domain, plist]);
        } else {
          await rm(plist, { force: true });
        }
      } catch {
        console.error('恢复原配置失败，请运行 pnpm autostart status 检查。');
      }
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
