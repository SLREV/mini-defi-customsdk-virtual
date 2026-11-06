/**
 * Uji endpoint dev `/api/pinata/status` & `/api/pinata/upload`
 * (Vite middleware) terhadap mock server Pinata — tanpa kredensial asli.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import {
  DevApiError,
  MAX_REQUEST_BYTES,
  createStatusHandler,
  createUploadHandler,
  handlePinataUpload,
  parseUploadPayload,
} from '../scripts/pinataDevApi';
import { readPinataConfig } from '../scripts/pinataUpload';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gagal mendapatkan port');
  }
  return { server, base: `http://127.0.0.1:${address.port}` };
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
  const servers: Server[] = [];

  try {
    // ------------------------------------------------ mock Pinata
    const captured: Captured[] = [];
    const mockPinata = await listen((req, res) => {
      void readBody(req).then((body) => {
        captured.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/pinning/pinFileToIPFS') {
          res.end(JSON.stringify({ IpfsHash: 'QmDevApiImage' }));
          return;
        }
        if (req.url === '/pinning/pinJSONToIPFS') {
          res.end(JSON.stringify({ IpfsHash: 'QmDevApiMeta' }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    servers.push(mockPinata.server);

    const configuredEnv: NodeJS.ProcessEnv = {
      PINATA_API_KEY: 'kunci-dev',
      PINATA_API_SECRET: 'rahasia-dev',
      PINATA_API_BASE: mockPinata.base,
      PINATA_GATEWAY: 'https://gw.uji.mypinata.cloud',
    };

    // ---------------------------------------- server API (middleware)
    const api = await listen((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/api/pinata/status')) {
        createStatusHandler({ env: configuredEnv })(req, res);
        return;
      }
      if (url.startsWith('/api/pinata/upload')) {
        createUploadHandler({ env: configuredEnv })(req, res);
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    servers.push(api.server);

    // 1) status: terkonfigurasi
    const statusOk = await fetch(`${api.base}/api/pinata/status`);
    const statusBody = (await statusOk.json()) as {
      configured: boolean;
      gateway: string | null;
      message: string;
    };
    assert.equal(statusOk.status, 200);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.gateway, 'https://gw.uji.mypinata.cloud');

    // 2) status: belum ada kredensial -> tetap 200 tapi configured=false
    const apiNoCreds = await listen((req, res) => {
      createStatusHandler({ env: {} })(req, res);
    });
    servers.push(apiNoCreds.server);
    const statusMissing = (await (
      await fetch(`${apiNoCreds.base}/api/pinata/status`)
    ).json()) as { configured: boolean; message: string };
    assert.equal(statusMissing.configured, false);
    assert.match(statusMissing.message, /Kredensial Pinata belum diset/);
    assert.match(statusMissing.message, /PINATA_JWT/);
    assert.match(statusMissing.message, /restart npm run dev/);
    // pesan harus satu baris (tidak membawa detail multi-baris dari CLI)
    assert.ok(!statusMissing.message.includes('\n'), 'pesan status harus satu baris');

    // 3) method salah -> 405
    const notPost = await fetch(`${api.base}/api/pinata/upload`, { method: 'GET' });
    assert.equal(notPost.status, 405);

    // 4) field wajib kurang -> 400
    const missing = await fetch(`${api.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'logo.png', base64: PNG_1PX.toString('base64') }),
    });
    assert.equal(missing.status, 400);
    assert.match(String(((await missing.json()) as { error: string }).error), /"name" wajib diisi/);

    // 5) ekstensi tidak didukung -> 400
    const badExt = await fetch(`${api.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'catatan.txt',
        base64: PNG_1PX.toString('base64'),
        name: 'X',
        symbol: 'X',
      }),
    });
    assert.equal(badExt.status, 400);
    assert.match(String(((await badExt.json()) as { error: string }).error), /tidak didukung/);

    // 6) body bukan JSON -> 400
    const badJson = await fetch(`${api.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bukan json',
    });
    assert.equal(badJson.status, 400);
    assert.match(String(((await badJson.json()) as { error: string }).error), /bukan JSON valid/);

    // 7) tanpa kredensial -> 503
    const noCredsApi = await listen((req, res) =>
      createUploadHandler({ env: {} })(req, res)
    );
    servers.push(noCredsApi.server);
    const noCreds = await fetch(`${noCredsApi.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'logo.png',
        base64: PNG_1PX.toString('base64'),
        name: 'X',
        symbol: 'X',
      }),
    });
    assert.equal(noCreds.status, 503);
    assert.match(String(((await noCreds.json()) as { error: string }).error), /Kredensial Pinata/);

    // 8) upload sukses -> 200 imageUri + metadataUri
    const ok = await fetch(`${api.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'logo.png',
        base64: `data:image/png;base64,${PNG_1PX.toString('base64')}`, // prefix data URL ikut ditangani
        name: 'Nusantara Token',
        symbol: 'nusa',
        telegram: 'https://t.me/nusa',
        twitter: 'https://x.com/nusa',
      }),
    });
    const result = (await ok.json()) as {
      imageUri: string;
      metadataUri: string;
      imageHash: string;
      metadataHash: string;
    };
    assert.equal(ok.status, 200);
    assert.equal(result.imageHash, 'QmDevApiImage');
    assert.equal(result.imageUri, 'https://gw.uji.mypinata.cloud/ipfs/QmDevApiImage');
    assert.equal(result.metadataHash, 'QmDevApiMeta');
    assert.equal(result.metadataUri, 'https://gw.uji.mypinata.cloud/ipfs/QmDevApiMeta');

    // Pinata menerima multipart gambar + JSON metadata yang benar
    const imageReq = captured.find((r) => r.url === '/pinning/pinFileToIPFS');
    assert.ok(imageReq);
    assert.equal(imageReq.headers.pinata_api_key, 'kunci-dev');
    assert.match(String(imageReq.headers['content-type']), /multipart\/form-data; boundary=/);
    assert.match(imageReq.body, /filename="upload-\d+\.png"/);
    assert.match(imageReq.body, /NUSA_Image\.png/);

    const metaReq = captured.find((r) => r.url === '/pinning/pinJSONToIPFS');
    assert.ok(metaReq);
    const metaBody = JSON.parse(metaReq.body) as {
      pinataContent: { name: string; symbol: string; image: string };
    };
    assert.equal(metaBody.pinataContent.name, 'Nusantara Token');
    assert.equal(metaBody.pinataContent.symbol, 'NUSA');
    assert.equal(metaBody.pinataContent.image, result.imageUri);

    // 9) Pinata menolak (401) -> 502 + detail
    const mockDenied = await listen((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { reason: 'INVALID_CREDENTIALS' } }));
    });
    servers.push(mockDenied.server);

    const deniedApi = await listen((req, res) =>
      createUploadHandler({
        env: {
          PINATA_API_KEY: 'salah',
          PINATA_API_SECRET: 'salah',
          PINATA_API_BASE: mockDenied.base,
        },
      })(req, res)
    );
    servers.push(deniedApi.server);

    const denied = await fetch(`${deniedApi.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'logo.png',
        base64: PNG_1PX.toString('base64'),
        name: 'X',
        symbol: 'X',
      }),
    });
    assert.equal(denied.status, 502);
    const deniedBody = (await denied.json()) as { error: string; detail: string };
    assert.match(deniedBody.error, /Pinata menolak upload \(HTTP 401\)/);
    assert.match(deniedBody.detail, /INVALID_CREDENTIALS/);

    // 10) validasi payload langsung (tanpa HTTP)
    assert.throws(() => parseUploadPayload(null), /harus berupa objek JSON/);
    assert.throws(
      () =>
        parseUploadPayload({
          fileName: 'logo.png',
          base64: Buffer.alloc(0).toString('base64'),
          name: 'X',
          symbol: 'X',
        }),
      (err: unknown) => err instanceof DevApiError && err.status === 400
    );
    // gambar > 10 MB ditolak (base64 dari 10 MB + 1 byte)
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64');
    assert.throws(
      () => parseUploadPayload({ fileName: 'logo.png', base64: oversize, name: 'X', symbol: 'X' }),
      /melebihi batas/
    );

    // 11) guard ukuran body (413)
    assert.ok(MAX_REQUEST_BYTES > 10 * 1024 * 1024);
    const hugeApi = await listen((req, res) =>
      createUploadHandler({ env: configuredEnv })(req, res)
    );
    servers.push(hugeApi.server);
    const huge = await fetch(`${hugeApi.base}/api/pinata/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'logo.png',
        base64: 'A'.repeat(MAX_REQUEST_BYTES + 1024),
        name: 'X',
        symbol: 'X',
      }),
    }).catch(() => null);
    // koneksi bisa diputus lebih dulu; kalau respons sampai, harus 413
    if (huge) {
      assert.equal(huge.status, 413);
    }

    // 12) handlePinataUpload langsung (tanpa HTTP) tetap bekerja
    const direct = await handlePinataUpload(
      { fileName: 'logo.png', base64: PNG_1PX.toString('base64'), name: 'X', symbol: 'x' },
      readPinataConfig(configuredEnv)
    );
    assert.equal(direct.imageUri, 'https://gw.uji.mypinata.cloud/ipfs/QmDevApiImage');

    // file sementara sudah dibersihkan (tidak ada sisa di tmpdir)
    const leftovers = (await import('node:fs')).readdirSync(tmpdir()).filter((f) =>
      f.startsWith('pinata-dev-')
    );
    assert.deepEqual(leftovers, []);

    console.log('ALL PINATA DEV-API TESTS PASSED!');
    console.log({
      endpoints: ['GET /api/pinata/status', 'POST /api/pinata/upload'],
      statusCodes: {
        configured: statusOk.status,
        notConfigured: 200,
        methodNotAllowed: notPost.status,
        missingField: missing.status,
        badExtension: badExt.status,
        noCredentials: noCreds.status,
        success: ok.status,
        pinataDenied: denied.status,
      },
    });
  } finally {
    await Promise.all(servers.map(close));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
