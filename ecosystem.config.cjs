// PM2 Ecosystem Configuration for FreshWax servers
// Start all: pm2 start ecosystem.config.cjs
// Stop all: pm2 stop all
// Restart all: pm2 restart all
// View status: pm2 status
// View logs: pm2 logs

module.exports = {
  apps: [
    {
      name: 'playlist-server',
      script: 'scripts/playlist-server.cjs',
      cwd: 'C:/Users/Owner/freshwax',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000, // Wait 5 seconds between restarts
      exp_backoff_restart_delay: 100, // Exponential backoff on crashes
      env: {
        NODE_ENV: 'production'
      },
      // Logging
      error_file: 'logs/playlist-server-error.log',
      out_file: 'logs/playlist-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Health check - restart if not responding
      max_memory_restart: '500M'
    },
    {
      name: 'audio-relay',
      script: 'scripts/audio-relay.cjs',
      cwd: 'C:/Users/Owner/freshwax',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/audio-relay-error.log',
      out_file: 'logs/audio-relay-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      max_memory_restart: '200M'
    }
  ]
};
