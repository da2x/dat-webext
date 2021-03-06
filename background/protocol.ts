import * as parseUrl from 'parse-dat-url';
import * as pda from 'pauls-dat-api';
import { join as joinPaths } from 'path';
import * as mime from 'mime';
import { DNSLookupFailed } from './errors';
import { Readable } from 'stream';
import { DatArchive } from './dat';

class StreamIterator {

  stream: Readable
  state: string
  chunks: Buffer[]
  waitingResolve: (result: Buffer) => any
  waitingReject: (error: any) => void
  error: any

  constructor(stream) {
    this.stream = stream;
    this.state = 'open';
    this.chunks = [];
    this.waitingResolve = null;
    this.waitingReject = null;
    stream.on('close', () => {
      this.state = 'closed';
      if (this.waitingResolve) {
        this.waitingResolve(null);
      }
    });
    stream.on('end', () => {
      this.state = 'end';
      if (this.waitingResolve) {
        this.waitingResolve(null);
      }
    });
    stream.on('error', (e) => {
      this.state = 'error'
      this.error = e;
      if (this.waitingReject) {
        this.waitingReject(this.error);
      }
    });
    stream.on('data', (chunk) => {
      if (this.waitingResolve !== null) {
        const resolve = this.waitingResolve;
        this.waitingReject = null;
        this.waitingResolve = null;
        resolve(chunk);
      } else {
        this.chunks.push(chunk);
      }
    });
  }

  async next(): Promise<Buffer> {
    if (this.chunks.length > 0) {
      return Promise.resolve(this.chunks.shift());
    } else if (this.state === 'error') {
      return Promise.reject(this.error);
    } else if (this.state != 'open') {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.waitingResolve = resolve;
      this.waitingReject = reject;
    });
  }
}

function responseText(string: string) {
  const encoder = new TextEncoder();
  return encoder.encode(string).buffer;
}

function timeoutWithError(ms, errorCtr) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(errorCtr());
    }, ms);
  })
}

async function* fileStream(archive, path) {
  const stream = archive._dataStructure.createReadStream(path, { start: 0 });
  const streamIt = new StreamIterator(stream);
  while (true) {
    const next = await streamIt.next();
    if (!next) {
      break;
    }
    yield next.buffer;
  }
}

const ERROR = {
  ARCHIVE_LOAD_TIMEOUT: 'ARCHIVE_LOAD_TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
  DIRECTORY: 'DIRECTORY',
}

class DatHandler {

  getArchiveFromUrl: (url: string) => Promise<any>

  constructor(getArchiveFromUrl) {
    this.getArchiveFromUrl = getArchiveFromUrl;
  }

  async loadArchive(url: string, timeout = 30000): Promise<DatArchive> {
    const loadArchive = this.getArchiveFromUrl(url);
    await Promise.race([
      loadArchive,
      timeoutWithError(timeout, () => new Error(ERROR.ARCHIVE_LOAD_TIMEOUT))
    ]);
    return loadArchive;
  }

  async resolvePath(url: string, host: string, pathname: string, version: number) {
    const timeoutAt = Date.now() + 30000;
    const archive = await this.loadArchive(url);
    const manifest = await pda.readManifest(archive._dataStructure).catch(_ => ({ }));
    const root = manifest.web_root || '';
    const path = decodeURIComponent(pathname);
    let lastPath;

    async function tryStat(testPath) {
      try {
        lastPath = testPath;
        return await archive.stat(testPath, { timeout: timeoutAt - Date.now() });
      } catch (e) {
        return false;
      }
    }

    let f = await tryStat(joinPaths(root, path));
    if (f && f.isFile()) {
      return {
        archive,
        path: lastPath,
      }
    }
    // for directories try to find an index file
    if (f && f.isDirectory()) {
      if (await tryStat(joinPaths(root, path, 'index.html'))) {
        return {
          archive,
          path: lastPath,
        }
      }
      if (await tryStat(joinPaths(root, path, 'index.htm'))) {
        return {
          archive,
          path: lastPath,
        }
      }
      // error list directory
      throw new Error(ERROR.DIRECTORY);
    }
    if (await tryStat(joinPaths(root, `${path}.html`))) {
      return {
        archive,
        path: lastPath,
      }
    }

    if (manifest.fallback_page) {
      if (await tryStat(joinPaths(root, manifest.fallback_page))) {
        return {
          archive,
          path: lastPath,
        }
      }
    }
    console.log('not found', root, path, await archive.readdir('/', { recursive: true }))
    throw new Error(ERROR.NOT_FOUND);
  }

  handleRequest(request: browser.protocol.Request): browser.protocol.Response {
    const self = this;
    const { host, pathname, version } = parseUrl(request.url);
    return {
      contentType: mime.getType(decodeURIComponent(pathname)) || 'text/html',
      content: (async function* () {
        try {
          const { archive, path } = await self.resolvePath(request.url, host, pathname, version);
          const data = fileStream(archive, path);
          for await (const chunk of data) {
            yield chunk;
          }
        } catch (e) {
          if (e instanceof DNSLookupFailed) {
            yield responseText(`Dat DNS Lookup failed for ${e.message}`);
            return;
          } else if (e.message === ERROR.ARCHIVE_LOAD_TIMEOUT) {
            yield responseText('Unable locate the Dat archive on the network.');
            return;
          } else if (e.message === ERROR.NOT_FOUND) {
            yield responseText(`Not found: ${e.toString()}`);
          } else if (e.message === ERROR.DIRECTORY) {
            const req = await fetch('/pages/directory.html');
            const contents = await req.text();
            yield responseText(contents);
          } else {
            console.error(e);
            yield responseText(`Unexpected error: ${e.toString()}`);
          }
        }
      })(),
    }
  }
}

export default DatHandler;
