/**
 * Endpoint upload Pinata untuk dashboard saat `npm run dev` (Vite middleware).
 *
 * Kenapa lewat server, bukan langsung dari browser?
 * `PINATA_JWT` adalah SECRET. Kalau dipakai di browser (prefix `VITE_*`), nilainya ikut
 * ter-bundle dan bisa dicuri siapa pun yang membuka DevTools. Middleware ini membaca
 * secret dari `.env` di sisi Node, lalu meneruskan upload ke Pinata.
 *
 * Endpoint (hanya aktif di dev server):
 *   GET  /api/pinata/status  -> { configured, gateway, message }
 *   POST /api/pinata/upload   -> { imageUri, metadataUri, imageHash, metadataHash }
 *        body JSON: { fileName, base64, name, symbol, telegram?, twitter?, website?, description? }
 *
 * Catatan: `npm run build` + `npm run preview` TIDAK menyertakan middleware ini.
 * Untuk produksi, pindahkan handler yang sama ke backend sungguhan.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  MAX_IMAGE_BYTES,
  MIME_BY_EXT,
  PinataApiError,
  type PinataConfig,
  type UploadResult,
  loadEnvFile,
  readPinataConfig,
  uploadTokenMetadata,
} from './pinataUpload';

/** Batas body request; base64 ~1.37x ukuran asli, jadi beri kelonggaran. */
export const MAX_REQUEST_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 64 * 1024;

export interface DevApiOptions {
  /** Sumber env eksplisit (dipakai test). Default: `process.env` + `.env`. */
  env?: NodeJS.ProcessEnv;
  /** Lokasi file `.env` bila `env` tidak diberikan. Default: `.env` di root proyek. */
  envPath?: string;
}

export interface UploadPayload {
  fileName: string;
  base64: string;
  name: string;
  symbol: string;
  telegram?: string;
  twitter?: string;
  website?: string;
  description?: string;
}

export class DevApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DevApiError';
    this.status = status;
  }
}

// ============================================================================
// HELPER HTTP
// ============================================================================

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new DevApiError(413, `Payload melebihi ${(limit / 1024 / 1024).toFixed(1)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

const stripDataUrlPrefix = (value: string): string => {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
};

// ============================================================================
// LOGIKA INTI (dapat diuji tanpa Vite)
// ============================================================================

/** Validasi payload JSON dari browser dan kembalikan buffer gambar + metadata input. */
export function parseUploadPayload(payload: unknown): {
  fileName: string;
  imageBytes: Buffer;
  ext: string;
  meta: { name: string; symbol: string; telegram?: string; twitter?: string; website?: string; description?: string };
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new DevApiError(400, 'Body harus berupa objek JSON');
  }
  const p = payload as Partial<UploadPayload> & Record<string, unknown>;

  for (const field of ['fileName', 'base64', 'name', 'symbol'] as const) {
    if (typeof p[field] !== 'string' || (p[field] as string).trim().length === 0) {
      throw new DevApiError(400, `Field "${field}" wajib diisi`);
    }
  }

  const fileName = (p.fileName as string).trim();
  const ext = extname(fileName).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    throw new DevApiError(
      400,
      `Format gambar tidak didukung (${ext || 'tanpa ekstensi'}). Pakai: ${Object.keys(MIME_BY_EXT).join(', ')}`
    );
  }

  const imageBytes = Buffer.from(stripDataUrlPrefix((p.base64 as string).trim()), 'base64');
  if (imageBytes.length === 0) {
    throw new DevApiError(400, 'File gambar kosong / base64 tidak valid');
  }
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    throw new DevApiError(
      400,
      `Ukuran gambar ${(imageBytes.length / 1024 / 1024).toFixed(2)} MB melebihi batas ${(
        MAX_IMAGE_BYTES / 1024 / 1024
      ).toFixed(0)} MB`
    );
  }

  const optional = (key: 'telegram' | 'twitter' | 'website' | 'description'): string | undefined => {
    const value = p[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };

  return {
    fileName,
    imageBytes,
    ext,
    meta: {
      name: (p.name as string).trim(),
      symbol: (p.symbol as string).trim(),
      telegram: optional('telegram'),
      twitter: optional('twitter'),
      website: optional('website'),
      description: optional('description'),
    },
  };
}

/**
 * Tulis gambar ke file sementara lalu jalankan pipeline upload Pinata yang sama
 * dengan CLI (validasi ukuran/format, pin gambar, pin JSON metadata).
 */
export async function handlePinataUpload(
  payload: unknown,
  config: PinataConfig,
  fetchImpl: typeof fetch = fetch
): Promise<UploadResult> {
  const { fileName, imageBytes, ext, meta } = parseUploadPayload(payload);

  const dir = mkdtempSync(join(tmpdir(), 'pinata-dev-'));
  const imagePath = join(dir, `upload-${Date.now()}${ext || extname(fileName)}`);
  writeFileSync(imagePath, imageBytes);

  try {
    return await uploadTokenMetadata(
      config,
      {
        imagePath,
        name: meta.name,
        symbol: meta.symbol,
        telegram: meta.telegram,
        twitter: meta.twitter,
        website: meta.website,
        description: meta.description,
      },
      fetchImpl
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveConfig(options: DevApiOptions): PinataConfig {
  if (options.env) {
    return readPinataConfig(options.env);
  }
  loadEnvFile(options.envPath ?? '.env');
  return readPinataConfig();
}

// ============================================================================
// HANDLER HTTP (kompatibel dengan connect/Vite middleware)
// ============================================================================

/**
 * Ubah error konfigurasi (yang di CLI berupa pesan multi-baris) menjadi satu kalimat
 * pendek yang aman ditampilkan di dashboard.
 */
export function describeCredentialError(err: unknown): string {
  const hint =
    'Isi PINATA_JWT (atau PINATA_API_KEY + PINATA_API_SECRET) di .env, lalu restart npm run dev.';
  const raw = err instanceof Error ? err.message : '';
  const first = raw.split('\n')[0].trim().replace(/:$/, '');
  // Pesan kredensial dari CLI sudah memuat kalimat "Isi salah satu di .env",
  // jadi cukup pakai kalimat baku agar tidak berulang.
  if (!first || /kredensial pinata belum diset/i.test(first)) {
    return `Kredensial Pinata belum diset. ${hint}`;
  }
  return `${first}. ${hint}`;
}

export function createStatusHandler(
  options: DevApiOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Gunakan GET' });
      return;
    }
    try {
      const config = resolveConfig(options);
      sendJson(res, 200, {
        configured: true,
        gateway: config.gateway,
        message: 'Pinata siap dipakai untuk upload dari dashboard',
      });
    } catch (err) {
      sendJson(res, 200, {
        configured: false,
        gateway: null,
        message: describeCredentialError(err),
      });
    }
  };
}

export function createUploadHandler(
  options: DevApiOptions = {},
  fetchImpl: typeof fetch = fetch
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Gunakan POST' });
        return;
      }

      try {
        let config: PinataConfig;
        try {
          config = resolveConfig(options);
        } catch (err) {
          throw new DevApiError(503, describeCredentialError(err));
        }

        const raw = await readBody(req);
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new DevApiError(400, 'Body bukan JSON valid');
        }

        const result = await handlePinataUpload(payload, config, fetchImpl);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof DevApiError) {
          sendJson(res, err.status, { error: err.message });
          return;
        }
        if (err instanceof PinataApiError) {
          sendJson(res, 502, {
            error: `Pinata menolak upload (HTTP ${err.status})`,
            detail: err.body.slice(0, 300),
          });
          return;
        }
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
}

// ============================================================================
// PLUGIN VITE
// ============================================================================

/**
 * Menambahkan `/api/pinata/status` & `/api/pinata/upload` ke dev server Vite.
 * Hanya untuk pengembangan lokal: `npm run build`/`preview` tidak menyertakannya.
 */
export function pinataDevApi(options: DevApiOptions = {}): Plugin {
  return {
    name: 'mini-defi:pinata-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/pinata/status', createStatusHandler(options));
      server.middlewares.use('/api/pinata/upload', createUploadHandler(options));
      server.config.logger.info(
        '  \u2713 Pinata dev API aktif: POST /api/pinata/upload (baca PINATA_JWT dari .env)'
      );
    },
  };
}
