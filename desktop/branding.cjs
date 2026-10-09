const fs = require('node:fs');
const path = require('node:path');

function setting(name, env = process.env) {
  return env[`MOSSENTRY_${name}`] ?? env[`SRVMGR_${name}`];
}

function databasePath(directory) {
  const current = path.join(directory, 'mossentry.db');
  const legacy = path.join(directory, 'server_manager.db');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

function userDataDirectory(appData, env = process.env) {
  const override = setting('USER_DATA_DIR', env);
  if (override) return path.resolve(override);
  const current = path.join(appData, 'Mossentry');
  // Keep the whole original directory so credentials and browser state stay together.
  for (const name of ['Mossentry', 'Server Manager', 'server-manager-desktop', 'luo-server-manager-desktop', 'Dry Cactus', 'Cactus']) {
    const candidate = path.join(appData, name);
    if (fs.existsSync(databasePath(path.join(candidate, 'data')))) return candidate;
  }
  return current;
}

module.exports = { setting, databasePath, userDataDirectory };
