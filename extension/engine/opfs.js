// Origin private file system (OPFS): data being downloaded is stored as piece files, so downloads resume after a browser restart.

let rootPromise = null;

export function tasksRoot() {
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('tasks', { create: true }));
  }
  return rootPromise;
}

export async function taskDir(id, ...sub) {
  let d = await (await tasksRoot()).getDirectoryHandle(id, { create: true });
  for (const s of sub) d = await d.getDirectoryHandle(s, { create: true });
  return d;
}

export async function removeTaskDir(id) {
  try {
    await (await tasksRoot()).removeEntry(id, { recursive: true });
  } catch (e) {
    if (e.name !== 'NotFoundError') console.warn('[opfs] remove failed', id, e);
  }
}

export async function listTaskDirs() {
  const out = [];
  for await (const [name, h] of (await tasksRoot()).entries()) if (h.kind === 'directory') out.push(name);
  return out;
}

export async function clearDir(dir) {
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  for (const n of names) {
    try { await dir.removeEntry(n, { recursive: true }); } catch (e) { console.warn('[opfs] clear', n, e); }
  }
}

export async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    throw e;
  }
}

export async function readFile(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeError') return null;
    throw e;
  }
}

export async function readJson(dir, name) {
  const f = await readFile(dir, name);
  if (!f || !f.size) return null;
  try { return JSON.parse(await f.text()); } catch { return null; }
}

export async function writeJson(dir, name, value) {
  await writeFile(dir, name, JSON.stringify(value));
}

/** File name → size for a directory */
export async function fileSizes(dir) {
  const map = new Map();
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file') continue;
    const f = await h.getFile();
    map.set(name, f.size);
  }
  return map;
}

/** A file written by appending (for remuxing output) */
export async function appendWriter(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable({ keepExistingData: false });
  let pos = 0;
  return {
    async append(u8) {
      const at = pos;
      await w.write(u8);
      pos += u8.byteLength;
      return at;
    },
    get size() { return pos; },
    async close() { await w.close(); return fh.getFile(); },
    async abort() { try { await w.abort(); } catch { /* ignore */ } },
  };
}
