export const RELEASE_METADATA_URL = 'https://zerowall.chengxunkeji.cn/stable/releases/latest.json';

export function parseReleaseMetadata(value, metadataUrl = RELEASE_METADATA_URL) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Release metadata must be an object.');
  }

  const version = requiredString(value.version, 'version');
  const assetUrl = requiredString(value.assetUrl ?? value.url, 'assetUrl');
  const assetName = requiredString(value.assetName, 'assetName');
  const assetSha256 = requiredString(value.assetSha256, 'assetSha256').toLowerCase();
  const sizeBytes = value.sizeBytes;
  const publishedAt = requiredString(value.publishedAt, 'publishedAt');
  const download = new URL(assetUrl);
  const metadata = new URL(metadataUrl);

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new TypeError(`Invalid release version: ${version}`);
  }
  if (download.protocol !== 'https:' || download.origin !== metadata.origin || !download.pathname.toLowerCase().endsWith('.exe')) {
    throw new TypeError(`Invalid Windows release URL: ${assetUrl}`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new TypeError('sizeBytes must be a positive integer.');
  }
  if (!/^[a-f0-9]{64}$/u.test(assetSha256)) {
    throw new TypeError('assetSha256 must be a SHA-256 hex digest.');
  }

  return {
    version,
    name: optionalString(value.name) ?? `ZeroWall Science ${version}`,
    publishedAt,
    assetUrl: download.href,
    assetName,
    assetSha256,
    sizeBytes,
  };
}

export function releaseSnapshot(metadata) {
  return [{
    tag: `v${metadata.version}`,
    name: metadata.name,
    published: metadata.publishedAt,
    url: metadata.assetUrl,
    assets: [{
      name: metadata.assetName,
      size: metadata.sizeBytes,
      url: metadata.assetUrl,
      sha256: metadata.assetSha256,
    }],
  }];
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
