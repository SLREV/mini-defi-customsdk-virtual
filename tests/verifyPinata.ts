/**
 * Uji script upload Pinata tanpa jaringan & tanpa kredensial asli:
 *   - parser .env, validasi konfigurasi, validasi file
 *   - bentuk metadata JSON
 *   - pipeline upload end-to-end terhadap mock server Pinata lokal (HTTP)
 *   - penanganan error HTTP (401)
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PINATA_API_BASE,
  DEFAULT_PINATA_GATEWAY,
  MAX_IMAGE_BYTES,
  PinataApiError,
  buildMetadataJson,
  ipfsUrl,
  loadEnvFile,
  parseArgs,
  pinJsonToIPFS,
  readPinataConfig,
  testAuthentication,
  uploadTokenMetadata,
  validateImageFile,
} from '../scripts/pinataUpload';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

async function startMockPinata(
  handler: (req: Captured, res: ServerResponse) => void
): Promise<{ server: Server; port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const entry: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      captured.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gagal mendapatkan port mock server');
  }
  return { server, port: address.port, captured };
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'pinata-test-'));
  const imagePath = join(workDir, 'logo.png');
  const emptyPath = join(workDir, 'kosong.png');
  const badExtPath = join(workDir, 'catatan.txt');
  const envPath = join(workDir, '.env');

  // PNG 1x1 transparan
  writeFileSync(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  writeFileSync(emptyPath, '');
  writeFileSync(badExtPath, 'bukan gambar');

  const servers: Server[] = [];
  try {
    // ---------------------------------------------------------------- 1. .env
    writeFileSync(
      envPath,
      ['# komentar', 'PINATA_API_KEY="kunci-uji"', "PINATA_API_SECRET='rahasia-uji'", 'PINATA_GATEWAY=https://gw.contoh.mypinata.cloud/', ''].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadEnvFile(envPath, env);
    assert.deepEqual(loaded, ['PINATA_API_KEY', 'PINATA_API_SECRET', 'PINATA_GATEWAY']);
    assert.equal(env.PINATA_API_KEY, 'kunci-uji');
    assert.equal(env.PINATA_API_SECRET, 'rahasia-uji');

    // nilai dari process.env tidak boleh ditimpa file .env
    const env2: NodeJS.ProcessEnv = { PINATA_API_KEY: 'dari-shell' };
    loadEnvFile(envPath, env2);
    assert.equal(env2.PINATA_API_KEY, 'dari-shell');

    // ------------------------------------------------- 2. konfigurasi Pinata
    assert.throws(() => readPinataConfig({}), /Kredensial Pinata belum diset/);

    const cfgKeys = readPinataConfig({
      PINATA_API_KEY: 'k',
      PINATA_API_SECRET: 's',
      PINATA_GATEWAY: 'https://gw.mypinata.cloud///',
    });
    assert.equal(cfgKeys.apiBase, DEFAULT_PINATA_API_BASE);
    assert.equal(cfgKeys.gateway, 'https://gw.mypinata.cloud');
    assert.equal(cfgKeys.jwt, undefined);

    const cfgJwt = readPinataConfig({ PINATA_JWT: 'jwt-uji' });
    assert.equal(cfgJwt.jwt, 'jwt-uji');
    assert.equal(cfgJwt.gateway, DEFAULT_PINATA_GATEWAY);

    // ------------------------------------------------------ 3. validasi file
    const valid = validateImageFile(imagePath);
    assert.equal(valid.ext, '.png');
    assert.equal(valid.mime, 'image/png');
    assert.equal(valid.fileName, 'logo.png');
    assert.equal(valid.bytes, 70);

    assert.throws(() => validateImageFile(join(workDir, 'tidak-ada.png')), /tidak ditemukan/);
    assert.throws(() => validateImageFile(emptyPath), /kosong/);
    assert.throws(() => validateImageFile(badExtPath), /tidak didukung/);
    assert.throws(() => validateImageFile(imagePath, 4), /melebihi batas/);
    assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);

    // ------------------------------------------------------- 4. URL & JSON
    assert.equal(ipfsUrl('https://gw.contoh', 'QmABC'), 'https://gw.contoh/ipfs/QmABC');
    assert.equal(ipfsUrl('https://gw.contoh///', 'QmABC'), 'https://gw.contoh/ipfs/QmABC');

    const json = buildMetadataJson(
      {
        name: '  Nusantara Token  ',
        symbol: ' nusa ',
        telegram: 'https://t.me/nusa',
        twitter: 'https://x.com/nusa',
        website: '',
      },
      'https://gw.contoh/ipfs/QmIMG'
    );
    assert.equal(json.name, 'Nusantara Token');
    assert.equal(json.symbol, 'NUSA');
    assert.equal(json.image, 'https://gw.contoh/ipfs/QmIMG');
    assert.equal(json.external_url, 'https://x.com/nusa');
    assert.deepEqual(json.extensions, {
      website: '',
      twitter: 'https://x.com/nusa',
      telegram: 'https://t.me/nusa',
    });
    assert.match(String(json.description), /Nusantara Token \(\$NUSA\)/);

    // --------------------------------------------------------- 5. argumen CLI
    const args = parseArgs([
      '--image', imagePath,
      '--name', 'Nusantara Token',
      '--symbol', 'NUSA',
      '--twitter', 'https://x.com/nusa',
      '--dry-run',
    ]);
    assert.equal(args.image, imagePath);
    assert.equal(args.name, 'Nusantara Token');
    assert.equal(args.symbol, 'NUSA');
    assert.equal(args.twitter, 'https://x.com/nusa');
    assert.equal(args.dryRun, true);
    assert.equal(args.out, 'pinata-upload-result.json');
    assert.throws(() => parseArgs(['--tidak-ada']), /tidak dikenal/);

    // ------------------------------- 6. pipeline end-to-end vs mock Pinata
    const mock = await startMockPinata((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/data/testAuthentication') {
        res.end(JSON.stringify({ message: 'Authentication Success' }));
        return;
      }
      if (req.url === '/pinning/pinFileToIPFS' && req.method === 'POST') {
        res.end(JSON.stringify({ IpfsHash: 'QmImageHashUji', PinSize: 70, Timestamp: '2026-01-01T00:00:00Z' }));
        return;
      }
      if (req.url === '/pinning/pinJSONToIPFS' && req.method === 'POST') {
        res.end(JSON.stringify({ IpfsHash: 'QmMetadataHashUji', PinSize: 300, Timestamp: '2026-01-01T00:00:00Z' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    servers.push(mock.server);

    const cfgMock = readPinataConfig({
      PINATA_API_KEY: 'kunci-uji',
      PINATA_API_SECRET: 'rahasia-uji',
      PINATA_API_BASE: `http://127.0.0.1:${mock.port}`,
      PINATA_GATEWAY: 'https://gw.contoh.mypinata.cloud',
    });

    const authText = await testAuthentication(cfgMock);
    assert.match(authText, /Authentication Success/);

    const result = await uploadTokenMetadata(cfgMock, {
      imagePath,
      name: 'Nusantara Token',
      symbol: 'nusa',
      telegram: 'https://t.me/nusa',
      twitter: 'https://x.com/nusa',
    });

    assert.equal(result.imageHash, 'QmImageHashUji');
    assert.equal(result.imageUri, 'https://gw.contoh.mypinata.cloud/ipfs/QmImageHashUji');
    assert.equal(result.metadataHash, 'QmMetadataHashUji');
    assert.equal(result.metadataUri, 'https://gw.contoh.mypinata.cloud/ipfs/QmMetadataHashUji');

    // header autentikasi terkirim pada setiap request
    for (const req of mock.captured) {
      assert.equal(req.headers.pinata_api_key, 'kunci-uji');
      assert.equal(req.headers.pinata_secret_api_key, 'rahasia-uji');
    }

    // request gambar: multipart dengan filename & pinataMetadata benar
    const imageReq = mock.captured.find((r) => r.url === '/pinning/pinFileToIPFS');
    assert.ok(imageReq, 'request pinFileToIPFS tidak terkirim');
    assert.match(String(imageReq.headers['content-type']), /multipart\/form-data; boundary=/);
    assert.match(imageReq.body, /name="file"; filename="logo.png"/);
    assert.match(imageReq.body, /name="pinataMetadata"/);
    assert.match(imageReq.body, /NUSA_Image\.png/);
    assert.match(imageReq.body, /name="pinataOptions"/);

    // request JSON: isinya metadata yang menunjuk ke URL gambar hasil upload
    const jsonReq = mock.captured.find((r) => r.url === '/pinning/pinJSONToIPFS');
    assert.ok(jsonReq, 'request pinJSONToIPFS tidak terkirim');
    assert.match(String(jsonReq.headers['content-type']), /application\/json/);
    const sent = JSON.parse(jsonReq.body) as {
      pinataContent: Record<string, unknown>;
      pinataMetadata: { name: string };
    };
    assert.equal(sent.pinataMetadata.name, 'NUSA_Metadata_JSON');
    assert.equal(sent.pinataContent.name, 'Nusantara Token');
    assert.equal(sent.pinataContent.symbol, 'NUSA');
    assert.equal(
      sent.pinataContent.image,
      'https://gw.contoh.mypinata.cloud/ipfs/QmImageHashUji'
    );
    assert.deepEqual(sent.pinataContent.extensions, {
      website: '',
      twitter: 'https://x.com/nusa',
      telegram: 'https://t.me/nusa',
    });

    // ------------------------------------------- 7. error HTTP (401) dipetakan
    const unauthorized = await startMockPinata((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { reason: 'INVALID_CREDENTIALS', details: 'bad key' } }));
    });
    servers.push(unauthorized.server);

    const cfg401 = readPinataConfig({
      PINATA_API_KEY: 'salah',
      PINATA_API_SECRET: 'salah',
      PINATA_API_BASE: `http://127.0.0.1:${unauthorized.port}`,
    });

    await assert.rejects(
      () => testAuthentication(cfg401),
      (err: unknown) => {
        assert.ok(err instanceof PinataApiError);
        assert.equal(err.status, 401);
        assert.match(err.body, /INVALID_CREDENTIALS/);
        return true;
      }
    );
    await assert.rejects(
      () => pinJsonToIPFS(cfg401, { name: 'x' }, 'x'),
      (err: unknown) => err instanceof PinataApiError && err.status === 401
    );

    console.log('ALL PINATA UPLOAD TESTS PASSED!');
    console.log({
      imageUri: result.imageUri,
      metadataUri: result.metadataUri,
      requests: mock.captured.map((r) => `${r.method} ${r.url}`),
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
    );
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
