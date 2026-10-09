// Use Electron's SVG renderer so no additional image conversion dependency is needed.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setName('Mossentry icon generator');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'icon.svg'));
    const svg = `data:image/svg+xml;base64,${source.toString('base64')}`;
    await window.loadURL('data:text/html,<html><body></body></html>');
    const dataURL = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(svg)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
      return canvas.toDataURL('image/png');
    })()`);
    const master = nativeImage.createFromDataURL(dataURL);
    if (master.isEmpty()) throw new Error('Could not render icon.svg');
    const png = size => master.resize({ width: size, height: size, quality: 'best' }).toPNG();
    const output = path.join(__dirname, 'icons');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'icon.png'), png(512));

    const chunks = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
      const data = png(size);
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(data.length + 8, 4);
      return Buffer.concat([header, data]);
    });
    const icnsHeader = Buffer.alloc(8);
    icnsHeader.write('icns');
    icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    fs.writeFileSync(path.join(output, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]));

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map(png);
    const icoHeader = Buffer.alloc(6 + sizes.length * 16);
    icoHeader.writeUInt16LE(1, 2);
    icoHeader.writeUInt16LE(sizes.length, 4);
    let offset = icoHeader.length;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size;
      icoHeader.writeUInt16LE(1, entry + 4);
      icoHeader.writeUInt16LE(32, entry + 6);
      icoHeader.writeUInt32LE(images[index].length, entry + 8);
      icoHeader.writeUInt32LE(offset, entry + 12);
      offset += images[index].length;
    });
    fs.writeFileSync(path.join(output, 'icon.ico'), Buffer.concat([icoHeader, ...images]));
    console.log('Generated Mossentry PNG, ICNS, and ICO icons from icon.svg.');
  } finally {
    window.destroy();
  }
}).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
