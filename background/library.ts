import * as RandomAccess from '@sammacbeth/random-access-idb-mutable-file';
import { createNode } from '@sammacbeth/dat-node';
import { DatArchive, Hyperdrive, CreateOptions } from './dat';
import resolve from './dns';

const ARCHIVE_LIST_KEY = 'archives';

export interface ArchiveMetadata extends browser.storage.StorageObject {
  isOwner: boolean
  key: string
  open: boolean
  created: number
  lastUsed: number,
  content?: {}
  metadata?: {}
}

export interface Archives extends browser.storage.StorageObject {
  [key: string]: ArchiveMetadata
}

interface DatStorage {
  getStorage(key: string): Promise<any>
}

interface DatDNS {
  resolve(name: string): Promise<string>
}

interface DatInfo {
  key: string
  dataStructureId: string
  discoveryKey?: string
  loadPromise: Promise<void>
  dataStructure: Hyperdrive
  isSwarming: boolean
  replicationStreams?: any[]
}

interface DatNode {
  storage: DatStorage
  dns: DatDNS
  _dats: {
    [key: string]: DatInfo
  }
  listen(port?: number): void
  close(): Promise<void>
  getArchive(address: string): Promise<DatArchive>
  createArchive(opts: CreateOptions): Promise<DatArchive>
  forkArchive(url: string, opts: CreateOptions): Promise<DatArchive>
  closeArchive(key: string): void
}

export default class DatLibrary implements DatStorage {

  storageLock: Promise<void>
  archives: Archives
  node: DatNode
  dns: DatDNS

  constructor() {
    this.storageLock = Promise.resolve();
    this.archives = {};
    this.dns = {
      resolve,
    }
    this.node = createNode({
      storage: this,
      dns: this.dns,
    });
  }

  async getStorage(key: string): Promise<any> {
    return await RandomAccess.mount({
      name: key,
      storeName: 'data',
    });
  }

  async init() {
    this.archives = ((await browser.storage.local.get(ARCHIVE_LIST_KEY))[ARCHIVE_LIST_KEY] || {}) as Archives;
  }

  async _persistArchives() {
    await this.storageLock;
    this.storageLock = browser.storage.local.set({ [ARCHIVE_LIST_KEY]: this.archives });
  }

  getArchiveState(key) {
    const info = this.node._dats[key];
    const open = info && info.isSwarming
    const state: ArchiveMetadata = this.archives[key] || { open, isOwner: false, key, created: Date.now(), lastUsed: 0 };
    if (open) {
      const drive = info.dataStructure
      state.content = {
        length: drive.content.length,
        byteLength: drive.content.byteLength,
        downloaded: drive.content.downloaded(),
      };
      state.metadata = {
        length: drive.metadata.length,
        byteLength: drive.metadata.byteLength,
        downloaded: drive.metadata.downloaded(),
      };
    }
    return state;
  }

  getArchives() {
    return Object.values(this.archives);
  }

  getLibraryArchives() {
    return this.getArchives().filter(({ inLibrary }) => inLibrary);
  }

  getArchivesStates() {
    return Object.keys(this.archives).map(key => this.getArchiveState(key));
  }

  closeArchive(key) {
    if (this.node._dats[key]) {
      this.node.closeArchive(key);
    }
  }

  async deleteArchive(key) {
    if (this.node._dats[key]) {
      throw 'Cannot delete an open archive';
    }
    window.indexedDB.deleteDatabase(key);
    return this._persistArchives();
  }

  async _addLibraryEntry(archive: DatArchive) {
    const key = archive._dataStructure.key.toString('hex');
    if (!this.archives[key]) {
      this.archives[key] = {
        key,
        open: true,
        created: Date.now(),
        lastUsed: Date.now(),
        isOwner: archive._dataStructure.writable,
        inLibrary: archive._dataStructure.writable,
      };
      try {
        const { title, description, type } = await archive.getInfo({ timeout: 30000 });
        this.archives[key].title = title;
        this.archives[key].description = description;
        this.archives[key].type = type;
      } catch(e) {
      }
      this._persistArchives();
    }
  }

  _touchLibraryEntry(archive: DatArchive) {
    if (!archive._dataStructure) {
      return;
    }
    const key = archive._dataStructure.key.toString('hex');
    if (this.archives[key]) {
      this.archives[key].lastUsed = Date.now();
    }
  }

  async getArchive(addr: string) {
    return this.getArchiveFromUrl(`dat://${addr}`);
  }

  async getArchiveFromUrl(url: string) {
    const key = await this.dns.resolve(url);
    const existing = key in this.node._dats;
    try {
      const archive = await this.node.getArchive(`dat://${key}`);

      if (!existing) {
        this._addLibraryEntry(archive);
      }
      this._touchLibraryEntry(archive);
      return archive;
    } catch (e) {
      console.error(e);
    }
  }


}
