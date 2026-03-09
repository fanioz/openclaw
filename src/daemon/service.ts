import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import { execFileSync } from "node:child_process";
import {
  installRegistryTask,
  isRegistryTaskInstalled,
  readRegistryTaskCommand,
  readRegistryTaskRuntime,
  restartRegistryTask,
  stopRegistryTask,
  uninstallRegistryTask,
} from "./registry.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

function isAdmin(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export type GatewayServiceInstallArgs = {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
};

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  stop: (args: {
    env?: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  restart: (args: {
    env?: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  isLoaded: (args: { env?: Record<string, string | undefined> }) => Promise<boolean>;
  readCommand: (env: Record<string, string | undefined>) => Promise<{
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    sourcePath?: string;
  } | null>;
  readRuntime: (env: Record<string, string | undefined>) => Promise<GatewayServiceRuntime>;
};

export function resolveGatewayService(): GatewayService {
  if (process.platform === "darwin") {
    return {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: async (args) => {
        await installLaunchAgent(args);
      },
      uninstall: async (args) => {
        await uninstallLaunchAgent(args);
      },
      stop: async (args) => {
        await stopLaunchAgent({
          stdout: args.stdout,
          env: args.env,
        });
      },
      restart: async (args) => {
        await restartLaunchAgent({
          stdout: args.stdout,
          env: args.env,
        });
      },
      isLoaded: async (args) => isLaunchAgentLoaded(args),
      readCommand: readLaunchAgentProgramArguments,
      readRuntime: readLaunchAgentRuntime,
    };
  }

  if (process.platform === "linux") {
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      install: async (args) => {
        await installSystemdService(args);
      },
      uninstall: async (args) => {
        await uninstallSystemdService(args);
      },
      stop: async (args) => {
        await stopSystemdService({
          stdout: args.stdout,
          env: args.env,
        });
      },
      restart: async (args) => {
        await restartSystemdService({
          stdout: args.stdout,
          env: args.env,
        });
      },
      isLoaded: async (args) => isSystemdServiceEnabled(args),
      readCommand: readSystemdServiceExecStart,
      readRuntime: async (env) => await readSystemdServiceRuntime(env),
    };
  }

  if (process.platform === "win32") {
    return {
      label: "Background Task",
      loadedText: "registered",
      notLoadedText: "missing",
      install: async (args) => {
        if (isAdmin()) {
          await installScheduledTask(args);
        } else {
          await installRegistryTask(args);
        }
      },
      uninstall: async (args) => {
        await uninstallScheduledTask(args).catch(() => {});
        await uninstallRegistryTask(args).catch(() => {});
      },
      stop: async (args) => {
        if (await isScheduledTaskInstalled({ env: args.env })) {
          await stopScheduledTask({ stdout: args.stdout, env: args.env });
        }
        if (await isRegistryTaskInstalled({ env: args.env })) {
          await stopRegistryTask({ stdout: args.stdout, env: args.env });
        }
      },
      restart: async (args) => {
        if (await isScheduledTaskInstalled({ env: args.env })) {
          await restartScheduledTask({ stdout: args.stdout, env: args.env });
        } else if (await isRegistryTaskInstalled({ env: args.env })) {
          await restartRegistryTask({ stdout: args.stdout, env: args.env });
        } else {
          throw new Error("Task not installed, please run install first.");
        }
      },
      isLoaded: async (args) => {
        const schInstalled = await isScheduledTaskInstalled(args);
        const regInstalled = await isRegistryTaskInstalled(args);
        return schInstalled || regInstalled;
      },
      readCommand: async (env) => {
        const schCmd = await readScheduledTaskCommand(env);
        if (schCmd) return schCmd;
        return await readRegistryTaskCommand(env);
      },
      readRuntime: async (env) => {
        if (await isScheduledTaskInstalled({ env })) {
          return await readScheduledTaskRuntime(env);
        }
        return await readRegistryTaskRuntime(env);
      },
    };
  }

  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
