import { vi, beforeEach } from 'vitest';

/**
 * chrome.storage.{local,sync} の最小モック。Map で往復を再現する。
 * 実 API が Promise を返すため Promise.resolve を明示的に返す
 * (async にすると await が無く require-await に引っかかる)。
 */
function createStorageArea() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((keys?: string | string[] | null) => {
      if (keys == null) return Promise.resolve(Object.fromEntries(store));
      const list = Array.isArray(keys) ? keys : [keys];
      const picked = list.filter((key) => store.has(key)).map((key) => [key, store.get(key)]);
      return Promise.resolve(Object.fromEntries(picked));
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      store.clear();
      return Promise.resolve();
    }),
  };
}

/**
 * Phase 2 で必要な範囲だけを持つ chrome API モック。
 * vitest-chrome を使わないのは、原作に複数のフォークが並立し保守状況が不透明なため。
 */
function createChromeMock() {
  return {
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.0.0-test' })),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    storage: { local: createStorageArea(), sync: createStorageArea() },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
  };
}

beforeEach(() => {
  vi.stubGlobal('chrome', createChromeMock());
});
