const fs = require('node:fs');
const path = require('node:path');

const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];
function checkMacOSCredentials(env = process.env) {
  const required = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
    'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`macOS releases require Developer ID signing and Apple notarization. Configure GitHub secrets: ${missing.join(', ')}. See docs/UPDATES.md.`);
  }
  if (!env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application: ')) {
    throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity; ad-hoc and development certificates cannot be used for a macOS release.');
  }
  if (!env.APPLE_SIGNING_IDENTITY.endsWith(`(${env.APPLE_TEAM_ID})`)) {
    throw new Error('APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID must belong to the same Apple Developer team.');
  }
}

function versionAt(root) { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
function onlyFile(directory, suffix) {
  const files = fs.readdirSync(directory).filter(name => name.endsWith(suffix));
  if (files.length !== 1) throw new Error(`Expected one ${suffix} file in ${directory}, found ${files.length}`);
  return path.join(directory, files[0]);
}

function stageRelease(root, platform, signed) {
  if (!platforms.includes(platform)) throw new Error(`Unsupported release platform: ${platform}`);
  const version = versionAt(root);
  const bundle = path.join(root, 'src-tauri/target/release/bundle');
  const output = path.join(root, 'release-stage');
  fs.mkdirSync(output, { recursive: true });
  const prefix = `Mossentry_${version}_${platform}`;
  const mac = platform.startsWith('darwin-');
  const installer = onlyFile(path.join(bundle, mac ? 'dmg' : 'nsis'), mac ? '.dmg' : '.exe');
  const installerName = `${prefix}${mac ? '.dmg' : '-setup.exe'}`;
  fs.copyFileSync(installer, path.join(output, installerName));
  if (!signed) return;

  const updater = mac ? onlyFile(path.join(bundle, 'macos'), '.app.tar.gz') : installer;
  const updaterName = mac ? `${prefix}.app.tar.gz` : installerName;
  const signature = fs.readFileSync(`${updater}.sig`, 'utf8').trim();
  if (!signature) throw new Error(`Missing updater signature for ${platform}`);
  if (mac) fs.copyFileSync(updater, path.join(output, updaterName));
  fs.copyFileSync(`${updater}.sig`, path.join(output, `${updaterName}.sig`));
  fs.writeFileSync(path.join(output, `${platform}.json`), JSON.stringify({ version, platform, file: updaterName, signature }));
}

function createManifest(root, directory, repository, tag, now = new Date()) {
  const version = versionAt(root);
  if (tag !== `v${version}`) throw new Error('Release tag and package version do not match');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const manifest = { version, notes: `Mossentry ${tag}`, pub_date: now.toISOString(), platforms: {} };
  for (const platform of platforms) {
    const fragment = JSON.parse(fs.readFileSync(path.join(directory, `${platform}.json`), 'utf8'));
    if (fragment.version !== version || fragment.platform !== platform || !fragment.signature?.trim()
      || typeof fragment.file !== 'string' || path.basename(fragment.file) !== fragment.file) {
      throw new Error(`Invalid update metadata for ${platform}`);
    }
    if (!fs.existsSync(path.join(directory, fragment.file))
      || fs.readFileSync(path.join(directory, `${fragment.file}.sig`), 'utf8').trim() !== fragment.signature) {
      throw new Error(`Missing updater package or mismatched signature for ${platform}`);
    }
    manifest.platforms[platform] = {
      signature: fragment.signature,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fragment.file)}`,
    };
  }
  fs.writeFileSync(path.join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { stageRelease, createManifest, checkMacOSCredentials };
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  if (process.argv[2] === 'check-macos-signing') checkMacOSCredentials();
  else if (process.argv[2] === 'stage') stageRelease(root, process.argv[3], process.argv.includes('--signed'));
  else if (process.argv[2] === 'manifest') createManifest(root, path.join(root, 'release'), process.env.GITHUB_REPOSITORY, process.env.GITHUB_REF_NAME);
  else throw new Error('Usage: release.cjs check-macos-signing | stage <platform> [--signed] | manifest');
}
