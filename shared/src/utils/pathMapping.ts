function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function toSmbPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/ /g, '%20');
}

export interface PathMappingOptions {
  windowsRoot: string;
  smbRoot: string;
}

export function mapWindowsPathToSharedPath(
  windowsPath: string,
  mapping?: PathMappingOptions,
): string {
  if (!mapping) {
    return toSmbPath(windowsPath);
  }

  const normalizedPath = normalizeWindowsPath(windowsPath);
  const normalizedRoot = normalizeWindowsPath(mapping.windowsRoot);

  if (!normalizedPath.startsWith(normalizedRoot)) {
    return toSmbPath(windowsPath);
  }

  const relativePath = windowsPath.slice(mapping.windowsRoot.length);
  const cleanedRelative = relativePath.replace(/^[/\\]/, '');
  const joined = cleanedRelative
    ? `${mapping.smbRoot.replace(/\/$/, '')}/${toSmbPath(cleanedRelative)}`
    : mapping.smbRoot;

  return joined;
}
