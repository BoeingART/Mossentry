module.exports = {
  appId: 'com.boeingart.mossentry',
  productName: 'Mossentry',
  directories: { output: 'release' },
  files: ['desktop/*.cjs', 'desktop/icons/*', 'package.json', '!node_modules/**/*'],
  extraResources: [{
    from: 'backend', to: 'backend',
    filter: ['app/**/*', 'ansible/**/*', 'launch.py',
      '!**/__pycache__/**', '!**/*.pyc', '!data/**/*'],
  }, { from: 'docs/INSTALL.md', to: 'INSTALL.md' }],
  asar: true,
  npmRebuild: false,
  mac: {
    target: ['dmg', 'zip'],
    icon: 'desktop/icons/icon.icns',
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '12.0',
    identity: null,
    artifactName: '${productName}-${version}-macOS-${arch}.${ext}',
    extraResources: [{ from: 'build/runtime', to: 'runtime' }],
  },
  win: {
    target: ['nsis'],
    icon: 'desktop/icons/icon.ico',
    artifactName: '${productName}-${version}-Windows-${arch}-Setup.${ext}',
    extraResources: [{ from: 'build/runtime', to: 'runtime' }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
