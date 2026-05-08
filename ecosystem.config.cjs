module.exports = {
  apps: [
    {
      name: 'claude-discord-bridge',
      script: 'dist/index.js',
      cwd: '/root/claude-discord-bridge',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'debug'
      }
    }
  ]
};
