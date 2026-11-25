import {createHash} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import sharp from 'sharp';

const maxBytes = 4 * 1024 * 1024;
export function decodePhoto(encoded: unknown): Buffer {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(maxBytes / 3) * 4 ||
      encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new HttpsError('invalid-argument', 'Upload one JPEG up to 4 MiB');
  }
  const photo = Buffer.from(encoded, 'base64');
  if (photo.length > maxBytes || photo.toString('base64') !== encoded || photo[0] !== 0xff || photo[1] !== 0xd8) {
    throw new HttpsError('invalid-argument', 'Upload one JPEG up to 4 MiB');
  }
  return photo;
}

export const checksum = (photo: Buffer) => createHash('sha256').update(photo).digest('hex');

export async function normalizePhoto(photo: Buffer): Promise<Buffer> {
  try {
    const image = sharp(photo, {limitInputPixels: 16_000_000, failOn: 'warning'});
    if ((await image.metadata()).format !== 'jpeg') throw new Error();
    const normalized = await image.autoOrient().resize(2400, 2400, {fit: 'inside', withoutEnlargement: true})
      .jpeg({quality: 88}).toBuffer();
    if (normalized.length > maxBytes) throw new Error();
    return normalized;
  } catch {
    throw new HttpsError('invalid-argument', 'Upload a readable JPEG up to 16 megapixels');
  }
}
