const PREFIX = 'ccl.docs.draft:';

export function draftKey(root, file) {
  return PREFIX + JSON.stringify([root, file]);
}

export function readDraft(storage, root, file) {
  try {
    const value = JSON.parse(storage.getItem(draftKey(root, file)) || 'null');
    return value && typeof value.text === 'string' && typeof value.baseVersion === 'string' ? value : null;
  } catch { return null; }
}

export function saveDraft(storage, root, file, text, baseVersion) {
  const saved = Date.now();
  storage.setItem(draftKey(root, file), JSON.stringify({ text, baseVersion, saved }));
  return saved;
}

export function clearDraft(storage, root, file) {
  try { storage.removeItem(draftKey(root, file)); } catch {}
}
