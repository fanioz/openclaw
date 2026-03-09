import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatGatewayServiceDescription, resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayStateDir } from "./paths.js";
import { parseCommandLine } from "./utils.js";

const execFileAsync = promisify(execFile);

const REGISTRY_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveRegistryName(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

export function resolveTaskScriptPath(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_TASK_SCRIPT?.trim();
  if (override) {
    return override;
  }
  const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
  const stateDir = resolveGatewayStateDir(env);
  return path.join(stateDir, scriptName);
}

export function resolveVbsWrapperPath(env: Record<string, string | undefined>): string {
  const stateDir = resolveGatewayStateDir(env);
  return path.join(stateDir, "gateway_hidden.vbs");
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export async function readRegistryTaskCommand(env: Record<string, string | undefined>): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
} | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("@echo")) {
        continue;
      }
      if (line.toLowerCase().startsWith("rem ")) {
        continue;
      }
      if (line.toLowerCase().startsWith("set ")) {
        const assignment = line.slice(4).trim();
        const index = assignment.indexOf("=");
        if (index > 0) {
          const key = assignment.slice(0, index).trim();
          const value = assignment.slice(index + 1).trim();
          if (key) {
            environment[key] = value;
          }
        }
        continue;
      }
      if (line.toLowerCase().startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) {
      return null;
    }
    return {
      programArguments: parseCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  } catch {
    return null;
  }
}

function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const lines: string[] = ["@echo off"];
  if (description?.trim()) {
    lines.push(`rem ${description.trim()}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) {
        continue;
      }
      lines.push(`set ${key}=${value}`);
    }
  }
  const command = programArguments.map(quoteCmdArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}

function buildVbsWrapper(scriptPath: string): string {
  // 0 = hidden window
  return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """${scriptPath}""", 0, False\n`;
}

async function execReg(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("reg", args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isRegistryTaskInstalled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const taskName = resolveRegistryName(args.env ?? (process.env as Record<string, string | undefined>));
  const res = await execReg(["query", REGISTRY_RUN_KEY, "/v", taskName]);
  return res.code === 0;
}

export async function installRegistryTask({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
}): Promise<{ scriptPath: string }> {
  const scriptPath = resolveTaskScriptPath(env);
  const vbsPath = resolveVbsWrapperPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });

  const taskDescription =
    description ??
    formatGatewayServiceDescription({
      profile: env.OPENCLAW_PROFILE,
      version: environment?.OPENCLAW_SERVICE_VERSION ?? env.OPENCLAW_SERVICE_VERSION,
    });

  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(scriptPath, script, "utf8");

  const vbs = buildVbsWrapper(scriptPath);
  await fs.writeFile(vbsPath, vbs, "utf8");

  const taskName = resolveRegistryName(env);
  // wscript.exe runs .vbs silently
  const runCommand = `wscript.exe "${vbsPath}"`;

  const create = await execReg(["add", REGISTRY_RUN_KEY, "/v", taskName, "/t", "REG_SZ", "/d", runCommand, "/f"]);

  if (create.code !== 0) {
    const detail = create.stderr || create.stdout;
    throw new Error(`Registry run key create failed: ${detail}`.trim());
  }

  // Also start it now
  await execFileAsync("wscript.exe", [vbsPath], { windowsHide: true });

  stdout.write("\n");
  stdout.write(`${formatLine("Installed Registry User Task", taskName)}\n`);
  stdout.write(`${formatLine("Task script", scriptPath)}\n`);
  stdout.write(`${formatLine("Wrapper script", vbsPath)}\n`);
  return { scriptPath };
}

export async function uninstallRegistryTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const taskName = resolveRegistryName(env);
  await execReg(["delete", REGISTRY_RUN_KEY, "/v", taskName, "/f"]);

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }

  const vbsPath = resolveVbsWrapperPath(env);
  try {
    await fs.unlink(vbsPath);
    stdout.write(`${formatLine("Removed wrapper script", vbsPath)}\n`);
  } catch {
    // Ignore
  }
}

// Windows doesn't make it easy to map a process to the exact registry run key that started it
// without WMI. We'll do a best-effort check if `node.exe` with our CLI args is running.
async function getRunningProcessIds(env: Record<string, string | undefined>): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("wmic", [
      "process",
      "where",
      "name='node.exe'",
      "get",
      "ProcessId,CommandLine",
    ], { windowsHide: true });

    const lines = stdout.split(/\r?\n/);
    const pids: number[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      // Very naive check: does the command line contain "openclaw gateway"?
      if (line.toLowerCase().includes("gateway") && line.toLowerCase().includes("openclaw")) {
         // wmic output puts ProcessId at the end usually
         const parts = line.trim().split(/\s+/);
         const pid = parseInt(parts[parts.length - 1], 10);
         if (!isNaN(pid)) {
           pids.push(pid);
         }
      }
    }
    return pids;
  } catch {
    return [];
  }
}

export async function stopRegistryTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const safeEnv = env ?? (process.env as Record<string, string | undefined>);
  const pids = await getRunningProcessIds(safeEnv);

  if (pids.length === 0) {
    stdout.write(`${formatLine("Stopped Registry User Task", "No running process found")}\n`);
    return;
  }

  for (const pid of pids) {
    try {
      await execFileAsync("taskkill", ["/F", "/PID", pid.toString()], { windowsHide: true });
    } catch {
      // Ignore errors killing individual processes
    }
  }
  const taskName = resolveRegistryName(safeEnv);
  stdout.write(`${formatLine("Stopped Registry User Task", taskName)}\n`);
}

export async function restartRegistryTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const safeEnv = env ?? (process.env as Record<string, string | undefined>);
  await stopRegistryTask({ stdout, env: safeEnv });

  const vbsPath = resolveVbsWrapperPath(safeEnv);
  try {
    await execFileAsync("wscript.exe", [vbsPath], { windowsHide: true });
    const taskName = resolveRegistryName(safeEnv);
    stdout.write(`${formatLine("Restarted Registry User Task", taskName)}\n`);
  } catch (err) {
    throw new Error(`Failed to restart task: ${err}`);
  }
}

export async function readRegistryTaskRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const isInstalled = await isRegistryTaskInstalled({ env });
  if (!isInstalled) {
    return {
      status: "stopped",
      missingUnit: true,
    };
  }

  const pids = await getRunningProcessIds(env);
  const isRunning = pids.length > 0;

  return {
    status: isRunning ? "running" : "stopped",
    state: isRunning ? "Running" : "Stopped",
  };
}
