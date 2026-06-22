process.on("unhandledRejection", (reason) => {
	console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
	console.error("Uncaught exception:", error);
	process.exitCode = 1;
});

const { validateRuntimeEnvironment } = await import("./core/env");
const { formatStartupSafetyBanner } = await import("./core/bot-config");

validateRuntimeEnvironment();
console.log(formatStartupSafetyBanner());

const { loadLastBotRunState } = await import("./bot/last-run-state");
const { startIpcServer } = await import("./ipc-server");
const { startMarketOpenScheduler } = await import("./bot/market-open-scheduler");

await loadLastBotRunState();
await startIpcServer();

if (process.env.BOT_RUN_ON_SCHEDULE === "true") {
	console.log("Starting market-open scheduler");
	startMarketOpenScheduler();
}

export {};
