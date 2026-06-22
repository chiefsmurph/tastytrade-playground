import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { getBidAskForSymbol, getUnderlyingPrice } from "./core/market-data";
import { fetchOptionChainWithVolume } from "./core/option-service";
import tastytradeApi from "./core/tastytrade-client";
import johnsTestRun from "./bot/johns-test-run";
import {
  getOptionHealthForSymbol,
  getTopOptionCandidateForSymbol,
} from "./bot/get-option-candidates-for-symbol";
import { getTimeOfDayExecutionTargetsForPstTime as getTargetsForPstTime } from "./bot/evaluate-trading-strategy";
import { getCurrentAllocationBudget } from "./bot/actions/manage-allocation";
import { getOptionCandidates } from "./bot/option-contracts";
import everyFourMinutes from "./bot/every-four-minutes";
import { cancelAllLiveOrders } from "./bot/execute-position-evaluations";
import seedSymbol from "./bot/seed-symbol";
import {
  getMarketOpenSchedulerStatus,
  startMarketOpenScheduler,
  stopMarketOpenScheduler,
} from "./bot/market-open-scheduler";
import { getLastBotRunState } from "./bot/last-run-state";
import { getRecentRunHistory } from "./bot/run-history";

type CommandHandler = (args: string[]) => Promise<unknown>;

type IpcRequest = {
  id?: string;
  command?: string;
  args?: string[];
};

type IpcResponse = {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const socketPath =
  process.env.TASTYTRADE_BOT_SOCKET ||
  path.join(process.cwd(), ".tastytrade-playground.sock");

export async function getDefaultAccountNumber(): Promise<string> {
  const accounts =
    await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  const accountNumber = accounts[0]?.account?.["account-number"];
  if (!accountNumber) {
    throw new Error("No account number available");
  }

  return accountNumber;
}

const commandHandlers: Record<string, CommandHandler> = {
  "core:getBidAskForSymbol": async ([symbol, timeoutMs]) => {
    assertArg(symbol, "symbol");
    const parsedTimeout = timeoutMs ? Number(timeoutMs) : undefined;
    return getBidAskForSymbol(symbol, parsedTimeout);
  },
  "core:getUnderlyingPrice": async ([symbol, timeoutMs]) => {
    assertArg(symbol, "symbol");
    const parsedTimeout = timeoutMs ? Number(timeoutMs) : undefined;
    return getUnderlyingPrice(symbol, parsedTimeout);
  },
  "core:cancelAllLiveOrders": async ([accountNumber]) => {
    const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
    return cancelAllLiveOrders(resolvedAccountNumber);
  },
  "core:fetchOptionChainWithVolume": async ([symbol]) => {
    assertArg(symbol, "symbol");
    return fetchOptionChainWithVolume(symbol);
  },
  "bot:getOptionCandidates": async ([symbol, side]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return getOptionCandidates(symbol, normalizedSide);
  },
  "bot:getTopOptionCandidateForSymbol": async ([symbol, side]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return getTopOptionCandidateForSymbol(symbol, normalizedSide);
  },
  "bot:getOptionHealthForSymbol": async ([symbol, side]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return getOptionHealthForSymbol(symbol, normalizedSide);
  },
  "bot:getTimeOfDayExecutionTargets": async ([timeOfDay]) => {
    return getTargetsForPstTime(timeOfDay);
  },
  "bot:getCurrentAllocationBudget": async ([accountNumber]) => {
    const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
    return getCurrentAllocationBudget(resolvedAccountNumber);
  },
  "bot:seedSymbol": async ([symbol, side, accountNumber]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return seedSymbol(symbol, normalizedSide, accountNumber);
  },
  "bot:johnsTestRun": johnsTestRun,
  "bot:everyFourMinutes": everyFourMinutes,
  "bot:getLastEveryFourMinutesRun": async () => getLastBotRunState(),
  "bot:getRecentRunHistory": async ([limit]) => {
    const parsedLimit = limit ? Number(limit) : 20;
    return getRecentRunHistory(parsedLimit);
  },
  "bot:getMarketOpenSchedulerStatus": async () =>
    getMarketOpenSchedulerStatus(),
  "bot:startMarketOpenScheduler": async () => startMarketOpenScheduler(),
  "bot:stopMarketOpenScheduler": async () => stopMarketOpenScheduler(),
};

export function startIpcServer() {
  cleanupStaleSocket();

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString();

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!raw) {
          continue;
        }

        const response = await handleRequest(raw);
        logResponse(response);
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  server.listen(socketPath, () => {
    console.log(`IPC server listening on ${socketPath}`);
    console.log("Available commands:");
    for (const command of Object.keys(commandHandlers)) {
      console.log(`- ${command}`);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        removeSocketFile();
        process.exit(0);
      });
    });
  }

  process.on("exit", removeSocketFile);
  return server;
}

async function handleRequest(raw: string): Promise<IpcResponse> {
  let request: IpcRequest;

  try {
    request = JSON.parse(raw) as IpcRequest;
  } catch {
    const response = {
      id: null,
      ok: false,
      error: "Invalid JSON request",
    };
    logRequest({ id: null, command: undefined, args: [] }, "invalid-json", raw);
    return response;
  }

  const id = request.id ?? null;
  const command = request.command;
  const args = Array.isArray(request.args) ? request.args : [];

  logRequest({ id, command, args }, "received");

  if (!command) {
    logRequest({ id, command, args }, "missing-command");
    return { id, ok: false, error: "Missing command" };
  }

  const handler = commandHandlers[command];
  if (!handler) {
    logRequest({ id, command, args }, "unknown-command");
    return { id, ok: false, error: `Unknown command: ${command}` };
  }

  logRequest({ id, command, args }, "route-hit");

  try {
    const result = await handler(args);
    return { id, ok: true, result };
  } catch (error) {
    const message = formatIpcError(error);
    return { id, ok: false, error: message };
  }
}

function formatIpcError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const maybeAxiosError = error as {
    message?: string;
    response?: {
      data?: unknown;
      status?: number;
    };
  };
  const responseData = maybeAxiosError.response?.data;

  if (responseData != null) {
    try {
      return JSON.stringify(responseData);
    } catch {}
  }

  return maybeAxiosError.message ?? String(error);
}

function logRequest(
  request: { id: string | null; command?: string; args: string[] },
  status: "received" | "route-hit" | "missing-command" | "unknown-command" | "invalid-json",
  raw?: string,
) {
  console.log(
    JSON.stringify({
      scope: "ipc-request",
      status,
      id: request.id,
      command: request.command ?? null,
      args: request.args,
      raw: raw ?? undefined,
      timestamp: new Date().toISOString(),
    }, null, 2),
  );
}

function logResponse(response: IpcResponse) {
  console.log(
    JSON.stringify({
      scope: "ipc-response",
      id: response.id,
      ok: response.ok,
      error: response.error ?? null,
      result: response.result ?? null,
      timestamp: new Date().toISOString(),
    }, null, 2),
  );
}

function assertArg(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
}

function cleanupStaleSocket() {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not clean up IPC socket ${socketPath}: ${message}`);
  }
}

function removeSocketFile() {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}