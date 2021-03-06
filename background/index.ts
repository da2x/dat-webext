import DatHandler from './protocol';
import DatLibrary from './library';
import DatApi from './api';

browser.processScript.setAPIScript(browser.runtime.getURL('web-api.js'));

// Once the size of stored archives exceeds this we will start pruning old data
const CACHE_SIZE_MB = 10;
// Time to keep seeding archives until closing
const CLOSE_ARCHIVES_AFTER_MS = 1000 * 60 * 10;

const library = new DatLibrary();
library.init().then(() => {
  // load my own archives and seeding archives
  library.getArchives().filter(a => a.isOwner || a.forceSeeding)
  .forEach((a) => {
    console.log('load', a.key);
    library.getArchive(a.key)
  });
});

(<any>window).library = library;

window.addEventListener('beforeunload', () => {
  library.node.close();
})

const getArchiveFromUrl = library.getArchiveFromUrl.bind(library);

const protocolHandler = new DatHandler(getArchiveFromUrl);
browser.protocol.registerProtocol('dat', (request) => {
  return protocolHandler.handleRequest(request);
});

const api = new DatApi(library);
(<any>window).api = api;



// manage open archives
setInterval(async () => {
  const archives = await library.getArchivesStates();
  // get archives which have active listeners
  const activeStreams = new Set();
  api.listenerStreams.forEach(({ key }) => activeStreams.add(key));

  archives.filter((a) => a.open && 
    !a.isOwner && 
    !activeStreams.has(a.key) && 
    !a.forceSeeding &&
    a.seedUntil < Date.now())
  .forEach((a) => {
    library.closeArchive(a.key);
  });
  const calculateUsage = (type) => type ? (type.downloaded / type.length) * type.byteLength : 0;
  const mb = 1024 * 1024;
  const usage = archives
    .filter(a => !a.isOwner)
    .map(a => ({ key: a.key, size: (calculateUsage(a.metadata) + calculateUsage(a.content)) / mb }));
  const totalUsage = usage.reduce((acc, a) => acc + (a.size || 0), 0);
  // prune data
  if (totalUsage > CACHE_SIZE_MB) {
    const pruneable = archives
      .filter(a => !a.open && !a.isOwner && !activeStreams.has(a.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (pruneable.length > 0) {
      console.log('prune archive', pruneable[0].key);
      library.deleteArchive(pruneable[0].key);
    }
  }
}, 60000);

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.startsWith('dat://')) {
    browser.pageAction.show(tabId);
  } else {
    browser.pageAction.hide(tabId);
  }
});
