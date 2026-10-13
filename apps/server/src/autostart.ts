import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const AUTOSTART_TASK = 'AiHub';

export function autostartSupported(): boolean {
  return process.platform === 'win32';
}

/** 生产构建入口。tsx 从 src 跑时指向旁边的 dist，编译后就是同目录的 index.js。 */
export function productionEntry(moduleUrl = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(here) === 'src'
    ? path.resolve(here, '../dist/index.js')
    : path.join(here, 'index.js');
}

/** dist/index.js 所在的仓库根目录，当作计划任务的工作目录。 */
export function autostartWorkdir(entryPath: string): string {
  return path.resolve(path.dirname(entryPath), '../../..');
}

/** PowerShell 单引号字符串。 */
export function quotePs(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 隐藏启动脚本。wscript.exe 是窗口程序，再用窗口样式 0 拉起 node，登录时不会弹出命令行。 */
export function launcherPath(workDir: string): string {
  return path.join(workDir, 'data', 'autostart.vbs');
}

export function launcherScript(nodePath: string, entryPath: string, workDir: string): string {
  const command = `"${nodePath}" "${entryPath}"`;
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(workDir)}`,
    `shell.Run ${vbsString(command)}, 0, False`,
  ].join('\r\n');
}

function vbsString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * 登录时由 wscript 后台启动已构建的网关。
 * schtasks /TR 会把第二个带引号的路径当成额外参数，所以改用计划任务的 Execute / Arguments。
 */
export function enableTaskScript(wscriptPath: string, launcherFile: string, workDir: string): string {
  const argument = `"${launcherFile}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$action = New-ScheduledTaskAction -Execute ${quotePs(wscriptPath)} -Argument ${quotePs(argument)} -WorkingDirectory ${quotePs(workDir)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${quotePs(AUTOSTART_TASK)} -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null`,
  ].join('\n');
}

export function disableTaskScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `Unregister-ScheduledTask -TaskName ${quotePs(AUTOSTART_TASK)} -Confirm:$false`,
  ].join('\n');
}

export function queryTaskScript(): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$task = Get-ScheduledTask -TaskName ${quotePs(AUTOSTART_TASK)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { 'no' } else { 'yes' }",
  ].join('\n');
}

function systemBinary(name: string): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

function powershellPath(): string {
  return systemBinary('WindowsPowerShell\\v1.0\\powershell.exe');
}

function wscriptPath(): string {
  return systemBinary('wscript.exe');
}

async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(powershellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { windowsHide: true });
    return String(stdout ?? '');
  } catch (error) {
    const extra = error as { stderr?: string; stdout?: string };
    const detail = String(extra.stderr || extra.stdout || (error instanceof Error ? error.message : error)).trim();
    throw new Error(detail ? `开机自启操作失败：${detail}` : '开机自启操作失败');
  }
}

export async function isLaunchAtLogin(): Promise<boolean> {
  if (!autostartSupported()) return false;
  const output = await runPowerShell(queryTaskScript());
  return output.trim() === 'yes';
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!autostartSupported()) {
    throw new Error('开机自启目前只支持 Windows');
  }
  const entry = productionEntry();
  const workDir = autostartWorkdir(entry);
  const launcherFile = launcherPath(workDir);
  if (!enabled) {
    if (await isLaunchAtLogin()) await runPowerShell(disableTaskScript());
    fs.rmSync(launcherFile, { force: true });
    return;
  }
  if (!fs.existsSync(entry)) {
    throw new Error('还没有生产构建。请先在项目根目录运行 npm run build，再打开开机自启。');
  }
  fs.mkdirSync(path.dirname(launcherFile), { recursive: true });
  const script = launcherScript(process.execPath, entry, workDir);
  fs.writeFileSync(launcherFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]));
  await runPowerShell(enableTaskScript(wscriptPath(), launcherFile, workDir));
}
