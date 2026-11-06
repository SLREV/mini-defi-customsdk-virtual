/**
 * Unggah gambar token + metadata JSON ke IPFS via Pinata (otomatis).
 *
 * Implementasi memakai REST API Pinata langsung dengan `fetch`/`FormData` bawaan
 * Node 18+ — TANPA dependensi (`@pinata/sdk` sudah deprecated & `dotenv` tidak perlu).
 *
 * Pemakaian:
 *   npm run pinata:upload -- --image ./logo.png --name "Nusantara Token" --symbol NUSA \
 *       --telegram https://t.me/nusa --twitter https://x.com/nusa
 *
 *   npm run pinata:check                     # hanya tes kredensial
 *   npm run pinata:upload -- --dry-run ...   # validasi input tanpa upload
 *
 * Env (lihat `.env.example`):
 *   PINATA_JWT                              # opsional, alternatif API key
 *   PINATA_API_KEY + PINATA_API_SECRET      # API key legacy
 *   PINATA_GATEWAY                          # opsional, mis. https://namagateway.mypinata.cloud
 *   PINATA_API_BASE                         # opsional (dipakai untuk test/mock, default https://api.pinata.cloud)
 *
 * PENTING: file ini hanya untuk CLI/Node. Jangan pernah memakai prefix `VITE_`
 * untuk secret Pinata — semua `import.meta.env.VITE_*` ikut ter-bundle ke browser.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ============================================================================
// KONSTANTA
// ============================================================================

export const DEFAULT_PINATA_API_BASE = 'https://api.pinata.cloud';
export const DEFAULT_PINATA_GATEWAY = 'https://gateway.pinata.cloud';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface PinataConfig {
  apiBase: string;
  gateway: string;
  jwt?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface ValidatedImage {
  path: string;
  fileName: string;
  ext: string;
  mime: string;
  bytes: number;
}

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  description?: string;
  website?: string;
  telegram?: string;
  twitter?: string;
}

export interface UploadResult {
  imageHash: string;
  imageUri: string;
  metadataHash: string;
  metadataUri: string;
}

export class PinataApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    super(`Pinata API error ${status}: ${body.slice(0, 500)}`);
    this.name = 'PinataApiError';
    this.status = status;
    this.body = body;
  }
}

// ============================================================================
// ENV & KONFIGURASI
// ============================================================================

/**
 * Parser `.env` minimal (tanpa dependensi). Nilai yang sudah ada di `process.env`
 * tidak ditimpa, sehingga `PINATA_API_KEY=... npm run pinata:upload` tetap menang.
 */
export function loadEnvFile(
  envPath = '.env',
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const absolute = resolve(envPath);
  if (!existsSync(absolute)) {
    return [];
  }
  const loaded: string[] = [];
  for (const rawLine of readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export function readPinataConfig(env: NodeJS.ProcessEnv = process.env): PinataConfig {
  const jwt = env.PINATA_JWT?.trim() || undefined;
  const apiKey = env.PINATA_API_KEY?.trim() || undefined;
  const apiSecret = env.PINATA_API_SECRET?.trim() || undefined;

  if (!jwt && !(apiKey && apiSecret)) {
    throw new Error(
      'Kredensial Pinata belum diset. Isi salah satu di .env:\n' +
        '  PINATA_JWT=...                                  (disarankan)\n' +
        '  atau PINATA_API_KEY=... + PINATA_API_SECRET=...'
    );
  }

  return {
    apiBase: stripTrailingSlash(env.PINATA_API_BASE?.trim() || DEFAULT_PINATA_API_BASE),
    gateway: stripTrailingSlash(env.PINATA_GATEWAY?.trim() || DEFAULT_PINATA_GATEWAY),
    jwt,
    apiKey,
    apiSecret,
  };
}

export const authHeaders = (config: PinataConfig): Record<string, string> =>
  config.jwt
    ? { Authorization: `Bearer ${config.jwt}` }
    : {
        pinata_api_key: config.apiKey as string,
        pinata_secret_api_key: config.apiSecret as string,
      };

export const ipfsUrl = (gateway: string, ipfsHash: string): string =>
  `${stripTrailingSlash(gateway)}/ipfs/${ipfsHash}`;

// ============================================================================
// VALIDASI FILE
// ============================================================================

export function validateImageFile(
  imagePath: string,
  maxBytes = MAX_IMAGE_BYTES
): ValidatedImage {
  const absolute = resolve(imagePath);
  if (!existsSync(absolute)) {
    throw new Error(`File gambar tidak ditemukan: ${absolute}`);
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    throw new Error(`Bukan file biasa: ${absolute}`);
  }
  if (stats.size === 0) {
    throw new Error(`File gambar kosong: ${absolute}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `Ukuran gambar ${(stats.size / 1024 / 1024).toFixed(2)} MB melebihi batas ${(
        maxBytes / 1024 / 1024
      ).toFixed(0)} MB`
    );
  }
  const ext = extname(absolute).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `Format gambar tidak didukung (${ext || 'tanpa ekstensi'}). Pakai: ${Object.keys(
        MIME_BY_EXT
      ).join(', ')}`
    );
  }
  return { path: absolute, fileName: basename(absolute), ext, mime, bytes: stats.size };
}

// ============================================================================
// METADATA JSON
// ============================================================================

/** JSON standar yang dibaca wallet/explorer dari `uri` on-chain. */
export function buildMetadataJson(
  input: TokenMetadataInput,
  imageUri: string
): Record<string, unknown> {
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  const twitter = input.twitter?.trim() ?? '';
  const telegram = input.telegram?.trim() ?? '';
  const website = input.website?.trim() ?? '';

  return {
    name,
    symbol,
    description:
      input.description?.trim() ||
      `${name} ($${symbol}) launched via Token-2022 Virtual Liquidity AMM.`,
    image: imageUri,
    external_url: twitter || website || '',
    extensions: { website, twitter, telegram },
  };
}

// ============================================================================
// PINATA REST API
// ============================================================================

async function parseResponse(res: Response): Promise<{ IpfsHash: string }> {
  const text = await res.text();
  if (!res.ok) {
    throw new PinataApiError(res.status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Respons Pinata bukan JSON: ${text.slice(0, 200)}`);
  }
  const hash = (parsed as { IpfsHash?: unknown }).IpfsHash;
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error(`Respons Pinata tanpa IpfsHash: ${text.slice(0, 200)}`);
  }
  return { IpfsHash: hash };
}

/** `pinFileToIPFS` — unggah file gambar biner sebagai multipart/form-data. */
export async function uploadImageToIPFS(
  config: PinataConfig,
  image: ValidatedImage,
  symbol: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ipfsHash: string; uri: string }> {
  const binary = readFileSync(image.path);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(binary)], { type: image.mime }), image.fileName);
  form.append(
    'pinataMetadata',
    JSON.stringify({ name: `${symbol.trim().toUpperCase()}_Image${image.ext}` })
  );
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetchImpl(`${config.apiBase}/pinning/pinFileToIPFS`, {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
  });

  const { IpfsHash } = await parseResponse(res);
  return { ipfsHash: IpfsHash, uri: ipfsUrl(config.gateway, IpfsHash) };
}

/** `pinJSONToIPFS` — unggah objek JSON metadata tanpa membuat file lokal. */
export async function pinJsonToIPFS(
  config: PinataConfig,
  content: Record<string, unknown>,
  name: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ipfsHash: string; uri: string }> {
  const res = await fetchImpl(`${config.apiBase}/pinning/pinJSONToIPFS`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pinataContent: content,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    }),
  });

  const { IpfsHash } = await parseResponse(res);
  return { ipfsHash: IpfsHash, uri: ipfsUrl(config.gateway, IpfsHash) };
}

/** Verifikasi kredensial tanpa mengunggah apa pun. */
export async function testAuthentication(
  config: PinataConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(`${config.apiBase}/data/testAuthentication`, {
    method: 'GET',
    headers: authHeaders(config),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PinataApiError(res.status, text);
  }
  return text;
}

/**
 * Pipeline lengkap: gambar -> IPFS, lalu JSON metadata (berisi URL gambar) -> IPFS.
 * `metadataUri` inilah yang dipakai sebagai `uri` on-chain Token-2022.
 */
export async function uploadTokenMetadata(
  config: PinataConfig,
  input: TokenMetadataInput & { imagePath: string },
  fetchImpl: typeof fetch = fetch
): Promise<UploadResult> {
  const image = validateImageFile(input.imagePath);
  const symbol = input.symbol.trim().toUpperCase();

  const imageUpload = await uploadImageToIPFS(config, image, symbol, fetchImpl);
  console.log(`\u2713 Gambar terunggah (${(image.bytes / 1024).toFixed(1)} KB): ${imageUpload.uri}`);

  const json = buildMetadataJson(input, imageUpload.uri);
  const metadataUpload = await pinJsonToIPFS(config, json, `${symbol}_Metadata_JSON`, fetchImpl);
  console.log(`\u2713 Metadata JSON terunggah: ${metadataUpload.uri}`);

  return {
    imageHash: imageUpload.ipfsHash,
    imageUri: imageUpload.uri,
    metadataHash: metadataUpload.ipfsHash,
    metadataUri: metadataUpload.uri,
  };
}

// ============================================================================
// CLI
// ============================================================================

export interface CliArgs {
  image?: string;
  name?: string;
  symbol?: string;
  description?: string;
  website?: string;
  telegram?: string;
  twitter?: string;
  out: string;
  dryRun: boolean;
  check: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: 'pinata-upload-result.json',
    dryRun: false,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    switch (key) {
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'check':
        args.check = true;
        break;
      case 'help':
        args.help = true;
        break;
      case 'out':
        args.out = argv[++i] ?? args.out;
        break;
      case 'image':
      case 'name':
      case 'symbol':
      case 'description':
      case 'website':
      case 'telegram':
      case 'twitter':
        args[key] = argv[++i] ?? '';
        break;
      default:
        throw new Error(`Argumen tidak dikenal: --${key}`);
    }
  }
  return args;
}

const USAGE = `
Unggah gambar + metadata token ke IPFS via Pinata.

  npm run pinata:upload -- --image <file> --name "<Nama Token>" --symbol <TICKER> [opsi]

Opsi:
  --image <path>       (wajib) file gambar: png/jpg/jpeg/gif/webp/svg, maks 10 MB
  --name <string>      (wajib) nama token
  --symbol <string>    (wajib) ticker token
  --description <str>  deskripsi (default dibuat otomatis)
  --website <url>      URL website
  --telegram <url>     URL Telegram
  --twitter <url>      URL X/Twitter
  --out <path>         simpan hasil JSON (default: pinata-upload-result.json)
  --dry-run            validasi input & cetak JSON metadata, tanpa upload
  --check              hanya verifikasi kredensial Pinata
  --help               tampilkan bantuan

Env: PINATA_JWT atau (PINATA_API_KEY + PINATA_API_SECRET), PINATA_GATEWAY (opsional).
`;

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (!args.check && (!args.image || !args.name || !args.symbol)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const input = {
    imagePath: args.image ?? '',
    name: args.name ?? '',
    symbol: args.symbol ?? '',
    description: args.description,
    website: args.website,
    telegram: args.telegram,
    twitter: args.twitter,
  };

  // Dry-run tidak membutuhkan kredensial: cukup validasi input + bentuk JSON.
  if (args.dryRun) {
    const image = validateImageFile(input.imagePath);
    const gateway = stripTrailingSlash(
      process.env.PINATA_GATEWAY?.trim() || DEFAULT_PINATA_GATEWAY
    );
    const json = buildMetadataJson(input, `${gateway}/ipfs/<IMAGE_HASH>`);
    console.log('\u2713 Validasi file OK:', JSON.stringify(image, null, 2));
    console.log('\u2713 Metadata JSON yang akan diunggah:', JSON.stringify(json, null, 2));
    console.log('\n(dry-run: tidak ada upload ke Pinata)');
    return;
  }

  const config = readPinataConfig();

  if (args.check) {
    await testAuthentication(config);
    console.log(`\u2713 Kredensial Pinata valid (API base: ${config.apiBase})`);
    return;
  }

  const result = await uploadTokenMetadata(config, input);

  console.log('\n=== Hasil ===');
  console.log(`imageUri    : ${result.imageUri}`);
  console.log(`metadataUri : ${result.metadataUri}`);
  console.log(
    '\nTempel "metadataUri" ke kolom Metadata URI di dashboard (on-chain `uri`),'
  );
  console.log('dan "imageUri" ke kolom Image URI (dipakai sebagai `image` di dalam JSON).');

  writeFileSync(
    args.out,
    JSON.stringify(
      {
        name: input.name,
        symbol: input.symbol.trim().toUpperCase(),
        ...result,
        uploadedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`\nDetail tersimpan di ${args.out}`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(
      `\n\u2716 Gagal: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
