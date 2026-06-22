const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "tastytrade-playground",
      cwd: __dirname,
      script: "./build/index.js",
      interpreter: process.env.PM2_NODE_INTERPRETER || "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
        BOT_RUN_ON_SCHEDULE: "true",
        TASTYTRADE_BOT_SOCKET: path.join(
          __dirname,
          ".tastytrade-playground.sock",
        ),
      },
    },
  ],
};
