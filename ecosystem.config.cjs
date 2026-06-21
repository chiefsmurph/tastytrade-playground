const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "tastytrade-playground",
      cwd: __dirname,
      script: "./build/index.js",
      interpreter: "/home/deploy/.nvm/versions/node/v24.17.0/bin/node",
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