function toSmbPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/ /g, '%20');
}

function toWindowsSegments(value: string): string[] {
  return value
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .split('\\')
    .filter((segment) => segment.length > 0);
}

function startsWithWindowsRoot(
  windowsPath: string,
  windowsRoot: string,
): { matches: boolean; relativeSegments: string[] } {
  const pathSegments = toWindowsSegments(windowsPath);
  const rootSegments = toWindowsSegments(windowsRoot);
  if (rootSegments.length === 0) {
    return {
      matches: false,
      relativeSegments: [],
    };
  }

  if (pathSegments.length < rootSegments.length) {
    return {
      matches: false,
      relativeSegments: [],
    };
  }

  for (let index = 0; index < rootSegments.length; index += 1) {
    if (pathSegments[index].toLowerCase() !== rootSegments[index].toLowerCase()) {
      return {
        matches: false,
        relativeSegments: [],
      };
    }
  }

  return {
    matches: true,
    relativeSegments: pathSegments.slice(rootSegments.length),
  };
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

  const rootCheck = startsWithWindowsRoot(windowsPath, mapping.windowsRoot);
  if (!rootCheck.matches) {
    return toSmbPath(windowsPath);
  }

  const cleanedRelative = rootCheck.relativeSegments.join('/');
  const joined = cleanedRelative.length > 0
    ? `${mapping.smbRoot.replace(/\/$/, '')}/${toSmbPath(cleanedRelative)}`
    : mapping.smbRoot;

  return joined;
}
