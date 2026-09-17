/** Fetch the authoritative Stable release metadata for the static fallback. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseReleaseMetadata, RELEASE_METADATA_URL, releaseSnapshot } from './release-metadata.mjs';

async function main() {
  const metadataUrl = process.env.ZEROWALL_RELEASE_METADATA_URL ?? RELEASE_METADATA_URL;
  const response = await fetch(metadataUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'zerowallscience-web' },
  });
  if (!response.ok) {
    throw new Error(`Release metadata returned HTTP ${response.status}.`);
  }

  const metadata = parseReleaseMetadata(await response.json(), metadataUrl);
  const data = releaseSnapshot(metadata);
  const outPath = resolve(import.meta.dirname, '../src/data/releases.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`releases.json written: ${metadata.version} -> ${metadata.assetUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
