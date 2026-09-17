import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseMetadata, RELEASE_METADATA_URL, releaseSnapshot } from '../release-metadata.mjs';

const valid = {
  version: '4.0.11',
  name: 'ZeroWall Science 4.0.11',
  publishedAt: '2026-08-21T09:33:40Z',
  assetUrl: 'https://zerowall.chengxunkeji.cn/stable/releases/4.0.11/zerowall-science-4.0.11-win-x64.exe',
  assetName: 'zerowall-science-4.0.11-win-x64.exe',
  assetSha256: 'd0b0babb8d7d88bd6cafa22fddb82939dee6ea3fd52b45d7cc51dc89c4a7b725',
  sizeBytes: 139297753,
};

test('accepts the authoritative ZeroWall Stable metadata', () => {
  const metadata = parseReleaseMetadata(valid);
  const [release] = releaseSnapshot(metadata);
  assert.equal(RELEASE_METADATA_URL, 'https://zerowall.chengxunkeji.cn/stable/releases/latest.json');
  assert.equal(release.tag, 'v4.0.11');
  assert.equal(release.assets[0].url, valid.assetUrl);
  assert.equal(release.assets[0].sha256, valid.assetSha256);
});

test('rejects downloads outside the authoritative HTTPS origin', () => {
  assert.throws(() => parseReleaseMetadata({ ...valid, assetUrl: 'https://example.com/malware.exe' }), /Invalid Windows release URL/u);
  assert.throws(() => parseReleaseMetadata({ ...valid, assetUrl: 'http://zerowall.chengxunkeji.cn/setup.exe' }), /Invalid Windows release URL/u);
});

test('rejects incomplete integrity metadata', () => {
  assert.throws(() => parseReleaseMetadata({ ...valid, assetSha256: 'bad' }), /SHA-256/u);
  assert.throws(() => parseReleaseMetadata({ ...valid, sizeBytes: 0 }), /positive integer/u);
});
