// pm2 fork mode only -- see CLAUDE.md rule. Never change to cluster or -i mode.
//
// WebSocket upgrades (used by the dashboard realtime feed) break under cluster
// mode because the master process owns the listening socket, not the workers.
// Keep exec_mode: 'fork' and instances: 1. kill_timeout matches the 10s force
// shutdown in server/src/index.ts so pm2 lets graceful teardown finish before
// SIGKILL.
//
// Filename note: this repo's package.json declares "type": "module", which
// would make a .js file load as ESM and ignore module.exports. The .cjs
// extension pins CommonJS semantics regardless of package scope, and pm2
// loads .cjs config files the same way it loads .js ones.

module.exports = {
  apps: [
    {
      name: 'claudepaw-server',
      script: 'dist/index.js',
      cwd: '/opt/claudepaw-server',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      kill_timeout: 10000,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PROJECT_ROOT: '/opt/claudepaw-server'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/claudepaw-server.error.log',
      out_file: '/var/log/claudepaw-server.out.log',
      merge_logs: true
    }
  ]
}
