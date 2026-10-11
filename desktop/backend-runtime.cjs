const path = require('node:path');

function backendCommand({ platform, packaged, resourcesPath, projectRoot, python }) {
  const directory = packaged ? path.join(resourcesPath, 'backend') : path.join(projectRoot, 'backend');
  const interpreter = platform === 'win32' ? 'python.exe' : 'bin/python3';
  const development = platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  return {
    executable: python || (packaged
      ? path.join(resourcesPath, 'runtime', interpreter)
      : path.join(projectRoot, development)),
    args: [path.join(directory, 'launch.py')],
    directory,
  };
}

module.exports = { backendCommand };
