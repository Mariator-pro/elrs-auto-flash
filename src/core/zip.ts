import { buffer } from 'node:stream/consumers';
import yauzl from 'yauzl';

// The entries of a zip that `wanted` picks, read into memory; the rest is skipped (a firmware
// archive is ~30 MB, a flash needs about 1 MB of it).
export function readZipEntries(path: string, wanted: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`cannot open ${path}`));
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/') || !wanted(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error(`cannot read ${entry.fileName}`));
          buffer(stream)
            .then((data) => {
              files.set(entry.fileName, data);
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  });
}
