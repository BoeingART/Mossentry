const fs = require('node:fs');
const path = require('node:path');

function validPreference(key, value) {
  return (key === 'language' && ['en', 'zh'].includes(value)) ||
    (key === 'colorScheme' && ['light', 'dark', 'auto'].includes(value));
}

function preferenceStore(directory) {
  const filename = path.join(directory, 'appearance.json');
  let values = {};
  try {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (saved && typeof saved === 'object') {
      values = Object.fromEntries(Object.entries(saved).filter(([key, value]) => validPreference(key, value)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.warn('Could not read appearance preferences:', error.message);
  }
  return {
    get: () => ({ ...values }),
    set(key, value) {
      if (!validPreference(key, value)) throw new Error('Invalid appearance preference');
      const next = { ...values, [key]: value };
      const temporary = `${filename}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, filename);
      values = next;
    },
  };
}

module.exports = { preferenceStore };
